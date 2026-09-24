#pragma once

// ---------------------------------------------------------------------------
// Audio
//
// IMPORTANT: on this board the ES7210 (capture) and ES8311 (playback) sit on a
// SINGLE I2S bus - codec_init.c makes one i2s_new_channel() call and derives
// both the TX and RX handles from the same clock config (MCLK 38 / BCLK 39 /
// WS 40). Capture and playback therefore cannot run at different sample rates
// while both are open. We run the whole pipeline at 16 kHz and let the backend
// resample Gemini's 24 kHz TTS down to match.
// ---------------------------------------------------------------------------
#define AUDIO_SAMPLE_RATE       16000
#define AUDIO_BITS_PER_SAMPLE   16
#define AUDIO_CODEC_CHANNELS    2      // both codecs are opened as stereo
#define AUDIO_MIC_CHANNEL       0      // which captured channel carries the mic

#define AUDIO_MAX_RECORD_SEC    10
#define AUDIO_MIN_RECORD_MS     350    // ignore accidental taps

// Mono 16-bit PCM capacity for one utterance.
#define AUDIO_CAPTURE_BUF_BYTES (AUDIO_SAMPLE_RATE * 2 * AUDIO_MAX_RECORD_SEC)

// The reply is buffered in PSRAM in full before a single sample is played.
// Streaming straight from the socket into the codec only works if the link
// sustains 32 KB/s; measured throughput on this board is about half that, so
// the codec starved mid-sentence and the speech came out chopped. Buffering
// decouples playback from the network entirely.
#define AUDIO_MAX_REPLY_SEC     30
#define AUDIO_REPLY_BUF_BYTES   (AUDIO_SAMPLE_RATE * 2 * AUDIO_MAX_REPLY_SEC)

// How much speech to bank before starting playback on a long reply. The backend
// synthesises long answers a sentence at a time and flushes each one, so we can
// begin after the first rather than waiting for the whole thing.
//
// Note TTS measures ~0.95x realtime, NOT comfortably faster, so this cushion is
// doing real work - it is what covers the jitter between chunks. The backend
// generates all chunks concurrently for the same reason; relying on generation
// to outpace playback would not be safe at 0.95x.
//
// Short replies arrive complete long before this threshold and simply play in
// full, so this only affects long answers.
#define AUDIO_PREBUFFER_MS      2500

// Frames pulled from the codec per read (32 ms at 16 kHz).
#define AUDIO_CHUNK_FRAMES      512

#define AUDIO_SPEAKER_VOLUME    100    // 0-100
#define AUDIO_MIC_GAIN          35     // dB-ish, matches the vendor example

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
// Show the model's reply as text on screen while it speaks. Off: the device is
// voice-only and SPEAKING is just the ring. The transcript and answer are still
// fetched and logged over serial either way, so debugging is unaffected.
#define UI_SHOW_ANSWER_TEXT     0

// Normal panel brightness. The AMOLED has no backlight, so this is the emitter
// level itself; sleeping the display means setting it to zero.
#define UI_BRIGHTNESS_PCT       100

// Idle behaviour, in two stages. The device sits on a shelf in a child's room
// for most of its life, so what it does when nobody is using it is most of what
// it does at all.
//
// After the first timeout it shows a picture - a galaxy by default, or whatever
// the parent uploaded. That is deliberate: an object that looks like something
// when it is doing nothing gets left out where a child can reach it, and one
// that shows a dead black disc gets put in a drawer.
//
// After the second it goes dark. On an AMOLED that is nearly all of the idle
// power, since black pixels do not emit. Any press wakes it straight back to
// the talk UI - there is no re-init, so waking is immediate.
#define UI_SCREENSAVER_AFTER_MS (1 * 60 * 1000)
#define UI_SLEEP_AFTER_MS       (5 * 60 * 1000)

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
#define WIFI_CONNECT_TIMEOUT_MS 20000
// A full round trip measured ~11.6s (3.5s to transcribe and answer, 7.4s of
// TTS). Leave generous headroom for longer answers plus the TLS handshake.
#define HTTP_TIMEOUT_MS         60000

#define META_TRANSCRIPT_MAX     256
#define META_ANSWER_MAX         600

// ---------------------------------------------------------------------------
// Bring-up
// ---------------------------------------------------------------------------
// Set to 1 to log per-channel mic RMS at boot instead of trusting
// AUDIO_MIC_CHANNEL blindly. See audio_probe_channels().
#define RUN_MIC_PROBE           0
