#include "audio.h"
#include "app_config.h"

#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp32_s3_touch_amoled_1.43c.h"

static const char *TAG = "audio";

static esp_codec_dev_handle_t s_speaker;
static esp_codec_dev_handle_t s_mic;

// Interleaved stereo scratch buffers sized for one chunk.
static int16_t *s_capture_chunk;   // AUDIO_CHUNK_FRAMES * 2 samples
static int16_t *s_play_chunk;      // AUDIO_CHUNK_FRAMES * 2 samples

// Mono capture accumulator (PSRAM).
static uint8_t *s_capture_buf;
static size_t s_capture_len;

// Per-channel energy for the current utterance. The ES7210 is a 4-mic TDM part
// and we only take two slots, so this is how we find out which slot actually
// carries voice instead of assuming.
static int64_t s_ch_energy[AUDIO_CODEC_CHANNELS];
static int64_t s_ch_frames;

// Reply accumulator (PSRAM). Filled from the network, drained to the speaker
// only once the download is complete.
static uint8_t *s_reply_buf;
static size_t s_reply_len;      // bytes received
static size_t s_reply_played;   // bytes already handed to the codec

#define CHUNK_SAMPLES (AUDIO_CHUNK_FRAMES * AUDIO_CODEC_CHANNELS)
#define CHUNK_BYTES   (CHUNK_SAMPLES * sizeof(int16_t))

esp_err_t audio_init(void)
{
    s_speaker = bsp_audio_codec_speaker_init();
    s_mic     = bsp_audio_codec_microphone_init();
    if (!s_speaker || !s_mic) {
        ESP_LOGE(TAG, "codec init failed (spk=%p mic=%p)", s_speaker, s_mic);
        return ESP_FAIL;
    }

    // Both handles ride the same I2S clock, so they must agree on the format.
    esp_codec_dev_sample_info_t fs = {};
    fs.sample_rate     = AUDIO_SAMPLE_RATE;
    fs.channel         = AUDIO_CODEC_CHANNELS;
    fs.bits_per_sample = AUDIO_BITS_PER_SAMPLE;

    ESP_ERROR_CHECK(esp_codec_dev_open(s_speaker, &fs));
    ESP_ERROR_CHECK(esp_codec_dev_open(s_mic, &fs));
    ESP_ERROR_CHECK(esp_codec_dev_set_out_vol(s_speaker, AUDIO_SPEAKER_VOLUME));
    ESP_ERROR_CHECK(esp_codec_dev_set_in_gain(s_mic, AUDIO_MIC_GAIN));

    s_capture_buf = (uint8_t *)heap_caps_malloc(AUDIO_CAPTURE_BUF_BYTES, MALLOC_CAP_SPIRAM);
    s_reply_buf   = (uint8_t *)heap_caps_malloc(AUDIO_REPLY_BUF_BYTES, MALLOC_CAP_SPIRAM);
    s_capture_chunk = (int16_t *)heap_caps_malloc(CHUNK_BYTES, MALLOC_CAP_DEFAULT);
    s_play_chunk    = (int16_t *)heap_caps_malloc(CHUNK_BYTES, MALLOC_CAP_DEFAULT);
    if (!s_capture_buf || !s_reply_buf || !s_capture_chunk || !s_play_chunk) {
        ESP_LOGE(TAG, "buffer alloc failed");
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "ready: %d Hz, %d ch, capture %d KB, reply %d KB",
             AUDIO_SAMPLE_RATE, AUDIO_CODEC_CHANNELS,
             AUDIO_CAPTURE_BUF_BYTES / 1024, AUDIO_REPLY_BUF_BYTES / 1024);
    return ESP_OK;
}

void audio_shutdown(void)
{
    // Closing the codecs is what disables the I2S channel and detaches its DMA
    // interrupt. See the header for why this is a correctness requirement
    // before OTA on this board, not a courtesy.
    if (s_mic) esp_codec_dev_close(s_mic);
    if (s_speaker) esp_codec_dev_close(s_speaker);
    ESP_LOGI(TAG, "codecs closed; I2S interrupt detached");
}

void audio_reply_reset(void) { s_reply_len = 0; s_reply_played = 0; }
size_t audio_reply_len(void) { return s_reply_len; }

uint32_t audio_reply_pending_ms(void)
{
    size_t pending = s_reply_len - s_reply_played;
    return (uint32_t)((pending / sizeof(int16_t)) * 1000ULL / AUDIO_SAMPLE_RATE);
}

uint32_t audio_reply_duration_ms(void)
{
    return (uint32_t)((s_reply_len / sizeof(int16_t)) * 1000ULL / AUDIO_SAMPLE_RATE);
}

bool audio_reply_append(const uint8_t *pcm, size_t len)
{
    if (s_reply_len + len > AUDIO_REPLY_BUF_BYTES) {
        ESP_LOGW(TAG, "reply buffer full at %zu bytes, truncating", s_reply_len);
        return false;
    }
    memcpy(s_reply_buf + s_reply_len, pcm, len);
    s_reply_len += len;
    return true;
}

esp_err_t audio_reply_play_pending(volatile bool *abort)
{
    // Play in slices so an abort is noticed promptly. Each slice blocks inside
    // the codec, which is what paces playback - and while we are blocked here
    // the TCP stack keeps filling the socket, so calling this from inside the
    // download loop overlaps speaking with receiving. If we ever get ahead of
    // the network, TCP backpressure simply stalls the sender; nothing is lost.
    const size_t slice = AUDIO_CHUNK_FRAMES * sizeof(int16_t);

    while (s_reply_played < s_reply_len) {
        if (abort && *abort) {
            ESP_LOGI(TAG, "playback aborted at %zu/%zu bytes", s_reply_played, s_reply_len);
            return ESP_OK;
        }
        size_t n = s_reply_len - s_reply_played;
        if (n > slice) n = slice;
        esp_err_t err = audio_play_mono(s_reply_buf + s_reply_played, n);
        if (err != ESP_OK) return err;
        s_reply_played += n;
    }
    return ESP_OK;
}

void audio_record_reset(void)
{
    s_capture_len = 0;
    s_ch_frames = 0;
    for (int c = 0; c < AUDIO_CODEC_CHANNELS; c++) s_ch_energy[c] = 0;

    // The mic is open from boot and nobody reads it while we sit idle, so its
    // DMA ring is already full of stale audio. Dropping a fixed number of
    // chunks is not enough - the ring can be many chunks deep, and whatever is
    // left becomes the start of the recording.
    //
    // Instead, drain until a read actually blocks. Buffered chunks come back
    // instantly; once we have caught up to real time a read has to wait for the
    // codec to clock in fresh samples, which takes about one chunk period.
    const int64_t chunk_us = (int64_t)AUDIO_CHUNK_FRAMES * 1000000 / AUDIO_SAMPLE_RATE;
    const int64_t live_us = (chunk_us * 2) / 3;
    int dropped = 0;

    for (int i = 0; i < 64; i++) {   // bounded: at most ~2s of draining
        int64_t t0 = esp_timer_get_time();
        if (esp_codec_dev_read(s_mic, s_capture_chunk, CHUNK_BYTES) != ESP_CODEC_DEV_OK) break;
        dropped++;
        if (esp_timer_get_time() - t0 >= live_us) break;   // read blocked: ring is dry
    }
    ESP_LOGD(TAG, "dropped %d stale chunk(s) before recording", dropped);
}

bool audio_record_pump(void)
{
    if (s_capture_len + AUDIO_CHUNK_FRAMES * sizeof(int16_t) > AUDIO_CAPTURE_BUF_BYTES) {
        return false;
    }
    if (esp_codec_dev_read(s_mic, s_capture_chunk, CHUNK_BYTES) != ESP_CODEC_DEV_OK) {
        return false;
    }

    // De-interleave: keep one channel as mono, and tally every channel's energy
    // so audio_record_log_levels() can report which slot is really the mic.
    int16_t *dst = (int16_t *)(s_capture_buf + s_capture_len);
    for (int i = 0; i < AUDIO_CHUNK_FRAMES; i++) {
        const int16_t *frame = &s_capture_chunk[i * AUDIO_CODEC_CHANNELS];
        dst[i] = frame[AUDIO_MIC_CHANNEL];
        for (int c = 0; c < AUDIO_CODEC_CHANNELS; c++) {
            s_ch_energy[c] += (int64_t)frame[c] * frame[c];
        }
    }
    s_ch_frames += AUDIO_CHUNK_FRAMES;
    s_capture_len += AUDIO_CHUNK_FRAMES * sizeof(int16_t);
    return true;
}

void audio_record_log_levels(void)
{
    if (s_ch_frames == 0) return;
    for (int c = 0; c < AUDIO_CODEC_CHANNELS; c++) {
        int rms = (int)__builtin_sqrt((double)s_ch_energy[c] / (double)s_ch_frames);
        ESP_LOGI(TAG, "  channel %d rms %5d%s", c, rms,
                 c == AUDIO_MIC_CHANNEL ? "   <- AUDIO_MIC_CHANNEL (sent upstream)" : "");
    }
}

const uint8_t *audio_record_data(void) { return s_capture_buf; }
size_t audio_record_len(void) { return s_capture_len; }

uint32_t audio_record_duration_ms(void)
{
    return (uint32_t)((s_capture_len / sizeof(int16_t)) * 1000ULL / AUDIO_SAMPLE_RATE);
}

esp_err_t audio_play_mono(const uint8_t *pcm, size_t len)
{
    const int16_t *src = (const int16_t *)pcm;
    size_t frames = len / sizeof(int16_t);
    size_t done = 0;

    while (done < frames) {
        size_t n = frames - done;
        if (n > AUDIO_CHUNK_FRAMES) n = AUDIO_CHUNK_FRAMES;

        for (size_t i = 0; i < n; i++) {
            int16_t s = src[done + i];
            for (int c = 0; c < AUDIO_CODEC_CHANNELS; c++) {
                s_play_chunk[i * AUDIO_CODEC_CHANNELS + c] = s;
            }
        }
        int err = esp_codec_dev_write(s_speaker, s_play_chunk,
                                      n * AUDIO_CODEC_CHANNELS * sizeof(int16_t));
        if (err != ESP_CODEC_DEV_OK) {
            ESP_LOGE(TAG, "codec write failed: %d", err);
            return ESP_FAIL;
        }
        done += n;
    }
    return ESP_OK;
}

void audio_probe_channels(void)
{
    const int kChunks = 30;  // ~1 second
    int64_t sum[AUDIO_CODEC_CHANNELS] = {0};

    for (int c = 0; c < kChunks; c++) {
        if (esp_codec_dev_read(s_mic, s_capture_chunk, CHUNK_BYTES) != ESP_CODEC_DEV_OK) return;
        for (int i = 0; i < AUDIO_CHUNK_FRAMES; i++) {
            for (int ch = 0; ch < AUDIO_CODEC_CHANNELS; ch++) {
                int32_t v = s_capture_chunk[i * AUDIO_CODEC_CHANNELS + ch];
                sum[ch] += (int64_t)v * v;
            }
        }
    }
    int64_t n = (int64_t)kChunks * AUDIO_CHUNK_FRAMES;
    for (int ch = 0; ch < AUDIO_CODEC_CHANNELS; ch++) {
        ESP_LOGI(TAG, "mic channel %d RMS = %d", ch,
                 (int)__builtin_sqrt((double)sum[ch] / (double)n));
    }
    ESP_LOGI(TAG, "(speak while this runs; the louder channel is the mic - "
                  "set AUDIO_MIC_CHANNEL to it)");
}
