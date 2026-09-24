#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Opens both codecs at AUDIO_SAMPLE_RATE and allocates the capture buffer in
// PSRAM. Must be called after the BSP display init (it owns the I2C bus).
esp_err_t audio_init(void);

// --- capture -------------------------------------------------------------
// Discards any stale DMA data and resets the write cursor.
void audio_record_reset(void);

// Pulls one chunk from the mic, extracts the mono channel and appends it to
// the capture buffer. Blocks for roughly one chunk duration (~32 ms).
// Returns false once the buffer is full.
bool audio_record_pump(void);

// Closes both codecs and tears down the I2S channel.
//
// MANDATORY before any OTA flash write on this board. CONFIG_I2S_ISR_IRAM_SAFE
// is not set, so the I2S DMA interrupt handler lives in flash - and every
// esp_ota_write() disables the cache while it erases and programs. An I2S
// interrupt arriving in that window would fetch from an disabled cache and
// panic, mid-update. Silence is not the point; not crashing is.
void audio_shutdown(void);

// Logs the RMS of every captured channel for the utterance just recorded.
// This is the calibration hook: whichever channel is loud when you speak is the
// microphone, and its level tells you where to put the backend's MIN_RMS gate.
void audio_record_log_levels(void);

// Mono 16-bit PCM captured so far.
const uint8_t *audio_record_data(void);
size_t audio_record_len(void);
uint32_t audio_record_duration_ms(void);

// --- playback ------------------------------------------------------------
// Writes mono 16-bit PCM to the speaker, duplicating each sample across the
// stereo frame the codec expects. Blocks until the codec has taken it all.
esp_err_t audio_play_mono(const uint8_t *pcm, size_t len);

// Reply buffering. The network cannot reliably keep up with real-time playback
// on this board, so the whole reply is collected first and played afterwards.
void audio_reply_reset(void);
bool audio_reply_append(const uint8_t *pcm, size_t len);
size_t audio_reply_len(void);
uint32_t audio_reply_duration_ms(void);

// Plays whatever has been appended but not yet played, then returns. Call it
// repeatedly as more data arrives to speak a reply while it is still
// downloading; call it once at the end to drain the remainder. Returns early if
// *abort is set, so a tap can interrupt playback.
esp_err_t audio_reply_play_pending(volatile bool *abort);

// Milliseconds of speech buffered but not yet played.
uint32_t audio_reply_pending_ms(void);

// Logs per-channel RMS for a short capture. The ES7210 is a dual-mic part and
// one of its slots may carry an echo reference rather than a mic, so this is
// how we confirm AUDIO_MIC_CHANNEL is pointing at real audio.
void audio_probe_channels(void);

#ifdef __cplusplus
}
#endif
