# Watima

Open source. Not for sale. The project page is [askwatima.com](https://askwatima.com/). That page is not in this repo.

This repo is what you run yourself: the firmware, the Firebase function, and the parent dashboard in `backend/web`. The dashboard is how a parent watches one device — questions, answers, and usage — on their own project, not a shared service.

A push-to-talk voice assistant for children, on a **Waveshare
ESP32-S3-Touch-AMOLED-1.43C** — the round 466×466 pendant
([ASIN B0GX9S7KGS](https://www.amazon.com/dp/B0GX9S7KGS)).

The point is the parent, not the gadget. A device answers nothing until a
parent pairs it. The parent sets the child's age, which sets how long the
answer is, and can read or delete every question. Memory is off, a short
session, or 30 days they can see.

Hold the button, ask a question, let go. The device uploads what it heard,
Gemini answers, and the reply comes back as speech.

```
  HOLD TO TALK ──press──▶ LISTENING ──release──▶ THINKING ──▶ ALMOST THERE ──▶ SPEAKING
     (grey)                 (green)               (amber)        (violet)        (blue)
                        capture 16 kHz         upload +        speech being    playing
                                               model answer     generated
```

| | |
| --- | --- |
| Firmware version | `0.2.0` (from `firmware/VERSION`) |
| Endpoint | `https://us-central1-watima-7d274.cloudfunctions.net/talk` |
| Firebase project | `watima-7d274` (Blaze) |
| Typical round trip | 5–9 s |

## Status

| | |
| --- | --- |
| ESP-IDF v5.5.5 toolchain | ✅ `~/esp/esp-idf` |
| Firmware build | ✅ clean, ~1.6 MB in a 3 MB slot (49 % free) |
| Full voice loop on hardware | ✅ mic → Wi-Fi → TLS → Gemini → speaker |
| Conversation memory | ✅ three postures, verified distinct |
| Per-device identity | ✅ enrolment + bearer tokens, impersonation closed |
| OTA update | ✅ end-to-end verified, `0.1.0 → 0.2.0` on real hardware |
| Firestore TTL | ✅ `ACTIVE` on `expireAt` |
| SoftAP setup portal | ⚠️ built, not yet exercised on hardware |
| Device claiming + parent accounts | ⛔ not started |
| Signed firmware images | ⛔ not started |
| Flash / NVS encryption | ⛔ decision due before manufacture |

---

## Layout

| Path | What it is |
| --- | --- |
| `firmware/` | ESP-IDF 5.5 app |
| `firmware/main/` | Application: UI, audio, net, config, provisioning, OTA |
| `firmware/components/` | Waveshare BSP (AMOLED, touch, codecs), from the vendor example |
| `firmware/VERSION` | Single source of firmware version — bump this to release |
| `backend/functions/` | Firebase Functions v2 — Gemini, memory, identity, firmware |
| `backend/release-firmware.sh` | Publish a build for OTA |
| `vendor-waveshare/` | Vendor reference checkout (gitignored) |

---

## Building from a clone

`firmware/main/secrets.h` is not in the repo. Copy the example and fill in
your own project. Do not point a build at someone else's function.

```bash
cp firmware/main/secrets.h.example firmware/main/secrets.h
```

| Value | What to put |
| --- | --- |
| `WIFI_SSID` / `WIFI_PASSWORD` | Optional. Leave the SSID empty and the device boots the setup portal. A parent types the password on their phone. |
| `BACKEND_URL` | The `talk` URL printed by `firebase deploy` on **your** project. |
| `BACKEND_API_KEY` | A long random string. The same string goes in Firebase: `firebase functions:secrets:set DEVICE_KEY`. That is what `/enroll` checks. |

Wi-Fi is stored on the device after setup. The URL and the enrolment key are
compiled in, then copied into NVS on first save. The portal never asks for them.

---

## Hardware facts worth knowing

Read out of the vendor sources and confirmed against the running board, not
guessed:

| Thing | Value |
| --- | --- |
| MCU | ESP32-S3-PICO-1 rev v0.2 — 8 MB flash, 8 MB **octal** PSRAM |
| Display | 466×466 AMOLED, CO5300 over QSPI (`D0..D3` 9/10/11/12, CS 15, SCK 14, RST 13, TE 8) |
| Touch | CST820 on I²C (RST 16, INT 17) — **polled**, not interrupt-driven |
| I²C | SDA 47, SCL 48 — shared by touch and both codecs |
| I²S | MCLK 38, BCLK 39, WS 40, DOUT 41, DIN 42 |
| Playback | ES8311 → NS4150 amp, PA enable GPIO 46 |
| Capture | **ES7210**, 4-mic TDM array (a *different* chip from playback) |
| Button | BOOT on GPIO 0 |
| Wi-Fi | 2.4 GHz only |

Three constraints these impose, each of which shaped the design:

**Capture and playback share one I²S clock.** `codec_init.c` makes a single
`i2s_new_channel()` call and derives both TX and RX from one clock config, so
they cannot run at different sample rates. The whole pipeline is 16 kHz and the
backend resamples Gemini's 24 kHz TTS down to match.

**Internal RAM is the scarce resource, not PSRAM.** TLS, the Wi-Fi buffers, the
AMOLED's SPI DMA bounce buffer and the audio codec all draw on the same ~260 KB.
Losing that race shows up as `spi_master: setup_dma_priv_buffer: Failed to
allocate priv TX buffer` and dropped frames. Wi-Fi/LWIP buffers are pushed into
PSRAM (`CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP`) to buy the headroom back.

**The I²S interrupt is not IRAM-safe.** `CONFIG_I2S_ISR_IRAM_SAFE` is unset, so
the audio DMA handler lives in flash — and every `esp_ota_write()` disables the
cache. Audio must be shut down before any OTA write or the device panics
mid-update. See `audio_shutdown()`.

---

## 1. Backend

Functions v2 runs on Cloud Run, so the project **must be on Blaze**.

```bash
cd backend
firebase login                      # as the project owner
firebase use watima-7d274
cd functions && npm install && cd ..
```

Secrets (already set on this project):

```bash
firebase functions:secrets:set GEMINI_API_KEY   # fallback key, see below
firebase functions:secrets:set DEVICE_KEY       # shared enrolment bootstrap key
```

Check Gemini before deploying:

```bash
cd functions
set -a; . ../../.gemini; set +a
npm run smoke                       # TTS only  -> reply.wav
node smoke.js recording.wav         # full path: audio -> answer -> reply.wav
```

Run the real handler locally:

```bash
npm run local                       # serves the actual handler on :5555
```

> Use `npm run local`, not `firebase emulators:start`. The functions emulator
> dies here with an opaque `Failed to load function`; `local-server.js` wraps the
> same exported handler in the same express/`rawBody` shape Cloud Run provides
> and gives real stack traces.

Deploy:

```bash
firebase deploy --only functions
firebase deploy --only firestore:rules,firestore:indexes
```

Model IDs are environment-overridable (`CHAT_MODEL`, `TTS_MODEL`, `VOICE`);
defaults are `gemini-3.6-flash`, `gemini-3.1-flash-tts-preview`, voice `Kore`.

---

## 2. Firmware

```bash
. ~/esp/esp-idf/export.sh           # every build shell needs this
cd firmware
idf.py build
idf.py -p /dev/cu.usbmodem* flash monitor
```

> On this Mac the ESP-IDF installer needs a CA bundle or every download fails:
> ```bash
> export SSL_CERT_FILE=$(/usr/local/bin/python3 -c "import certifi; print(certifi.where())")
> ```

**Partition changes need a full erase**, because the table moved to `0x10000`:

```bash
idf.py -p /dev/cu.usbmodem* erase-flash && idf.py -p /dev/cu.usbmodem* flash
```

An erase also wipes NVS, which drops the Wi-Fi settings **and the enrolment
token** — the device will re-enrol on next boot, which only succeeds if the
device has been released server-side.

### Back up the factory firmware

Already captured at `backups/factory-01_Fac-full-8MB.bin` (8 MB, verified).
For another unit:

```bash
esptool.py -p /dev/cu.usbmodem* read_flash 0 0x800000 factory-backup.bin
```

---

## 3. Device setup

Settings live in NVS, so a device can be configured without a reflash.

**Entering setup mode** — automatic when there is no saved network or the saved
one fails, or deliberately by **holding BOOT while powering on**.

1. The screen shows `SETUP`, a QR code and the network name.
2. Scan the QR — it joins `Watima-Setup-XXXX` directly. (Or join that open
   network and browse to `192.168.4.1`.)
3. Pick a network, enter the password, paste a Gemini API key.
4. Save. The device reboots and joins.

A DNS hijack answers every lookup with `192.168.4.1`, which is what makes a
phone's captive-portal check open the page by itself.

> **Why setup must be local.** A device with no working network cannot reach a
> remote config service. Wi-Fi setup is a bootstrap problem and has to happen
> over a network the device provides itself. Only *non-bootstrap* settings can
> sensibly live remotely.

---

## 4. Bring-up checks

1. **Display + touch** — the grey `HOLD TO TALK` ring; pressing turns it green.
2. **Microphone channel** — the ES7210 is a 4-mic TDM part and we take two
   slots. Every recording logs both:
   ```
   audio:   channel 0 rms   878   <- AUDIO_MIC_CHANNEL (sent upstream)
   audio:   channel 1 rms  1057
   ```
   Both being loud confirms they are real mics rather than one mic plus an echo
   reference. Measured 843–951 across utterances, so `AUDIO_MIC_CHANNEL 0` is
   correct on this hardware.
3. **Network** — `got ip …`, then `watima ready (fw 0.2.0)`.
4. **Enrolment** — first boot logs the device trading the bootstrap key for its
   own token. Later boots log `token=enrolled`.
5. **Full loop** — `captured … ms` → `understood …` → `speaking … ms`.

---

## Wire protocol

```
POST /
Authorization: Bearer <per-device token>
X-Gemini-Key:  <owner's key>            (optional; see SECURITY.md)
Content-Type:  audio/L16;rate=16000;channels=1
body:          raw mono PCM16LE @ 16 kHz

200 OK
X-Transcript:      <percent-encoded>
X-Answer:          <percent-encoded>
Content-Type:      audio/L16;rate=16000;channels=1
Transfer-Encoding: chunked
body:              raw mono PCM16LE @ 16 kHz
```

There is **no `X-Device-Id`**. Identity is resolved from the token; a device id
sent in a header is ignored. Identity is the token.

Other endpoints: `POST /enroll`, `POST /fw/check`, `GET /fw/download`.

**Why the body is chunked.** Headers are flushed as soon as the *answer text*
exists, before TTS starts, so the body length is unknown up front. Once headers
are out the status line is committed — a TTS failure can then only end the body
early, and the device keeps the text with nothing to play.

**How long answers stay responsive.** An answer over `STREAM_THRESHOLD_CHARS`
(140) is split on sentence boundaries and each chunk flushed as it is
synthesised, so the device starts speaking after the *first sentence*. It banks
`AUDIO_PREBUFFER_MS` (2.5 s) before starting.

Two non-obvious things make that work:

- **Chunks are generated concurrently, not sequentially.** TTS measures ~0.95×
  realtime — barely faster than playback. Sequentially, a short opening sentence
  buys a fast start then drains before the next chunk exists, leaving a gap
  mid-reply. Firing all chunks at once makes total time `max(chunk)` rather than
  `sum(chunks)`.
- **The first sentence is never merged with its neighbour.** It alone sets
  time-to-first-audio.

Measured on a 13.3 s four-sentence answer:

| | sequential | concurrent |
| --- | --- | --- |
| first audio | 6,400 ms | **2,895 ms** |
| all chunks ready | 11,418 ms | **5,048 ms** |
| playback gaps | starves | **0** |

Concatenation is safe because TTS output starts and ends at silence — measured
seam discontinuity is exactly 0.

---

## Conversation memory

```
conversation/{autoId} = { deviceId, q, a, ts, expireAt }
index: (deviceId ASC, ts DESC)
```

A flat collection queried with `where(deviceId) + orderBy(ts desc) + limit(6)`.
That needs the composite index in `firestore.indexes.json` — Firestore will not
serve it from single-field indexes. With it, the read touches only the 6
documents it returns however large the collection grows.

Only the transcribed question and spoken answer are stored — no prompts, no
audio — capped at 300 chars each.

### Postures

Set per device in `deviceSettings/{deviceId}.memoryMode`:

| Mode | Behaviour | Retention |
| --- | --- | --- |
| `off` | No memory. Every question stands alone. | nothing stored |
| `session` | **Default.** Recent turns from the last 60 min only. | 1 day |
| `persistent` | Full history, parent-visible. Opt-in. | 30 days |

Verified distinct on hardware:

```
session:  "What is the capital of France?" → "The capital of France is Paris."
          "How many people live there?"    → "About two point one million people live in Paris."
off:      "How many people live there?"    → "If you mean on Earth, about eight billion people live here."
```

This is switchable because it is a **positioning decision**, not just a product
one.

Retention is enforced by a Firestore TTL policy on `expireAt` (state `ACTIVE`),
so deletion is a property of the data rather than a promise in a policy
document.

`firestore.rules` denies **all** client access. The device never touches
Firestore; only the function does, via the Admin SDK, which bypasses rules
entirely. Permissive rules would enable nothing that exists while exposing every
device's history to anyone who learned the project ID.

---

## Tuning

| Knob | Where | Note |
| --- | --- | --- |
| `AUDIO_MIC_GAIN` | `main/app_config.h` | raise if the backend logs a low rms |
| `AUDIO_SPEAKER_VOLUME` | `main/app_config.h` | 0–100, currently 100 |
| `AUDIO_MAX_RECORD_SEC` | `main/app_config.h` | sizes the capture buffer |
| `AUDIO_PREBUFFER_MS` | `main/app_config.h` | speech banked before playback starts |
| `UI_SHOW_ANSWER_TEXT` | `main/app_config.h` | `0` = voice-only |
| `MIN_RMS` | `backend/functions/index.js` | silence gate; real utterances measure ~880 |
| `MAX_ANSWER_CHARS` | `backend/functions/index.js` | hard ceiling, 400 |
| Personality / length | `SYSTEM_PROMPT` in `index.js` | answer length is the main latency driver |
| State colours & sizes | `kStyles[]` in `main/ui.cpp` | one row per UI state |

---

## Third-party code

| Path | License |
| --- | --- |
| `firmware/components/externlib/codec_board/` | Espressif Modified MIT. Use only with Espressif chips. See that directory's `LICENSE`. |
| `firmware/components/port_bsp/` | Board support copied from the Waveshare ESP32-S3-Touch-AMOLED-1.43C example ([upstream](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.43C)). That repo ships no license file. It is included so this firmware builds. |
