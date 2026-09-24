#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "app_config.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char transcript[META_TRANSCRIPT_MAX];  // what the device heard
    char answer[META_ANSWER_MAX];          // what the model replied
} talk_meta_t;

// Fired once the response headers land - before any audio arrives - so the UI
// can switch to SPEAKING and show the text while the voice is still streaming.
typedef void (*net_meta_cb)(const talk_meta_t *meta, void *ctx);

// Fired repeatedly with mono 16-bit PCM at AUDIO_SAMPLE_RATE.
typedef esp_err_t (*net_audio_cb)(const uint8_t *data, size_t len, void *ctx);

// Exchanges the shared bootstrap key for a per-device token and stores it.
// Runs once, on the first boot after the device has network. Enrollment is
// one-time server-side, so a device already in the field cannot be taken over
// by someone who extracted the bootstrap key from another unit.
// The MAC-derived id the backend knows this device by, and the same string a
// parent types into the dashboard to remove it.
const char *net_device_id(void);

esp_err_t net_enroll(void);

// Tells the backend this device is about to erase itself, authenticated with
// the token it is about to throw away. Call BEFORE wiping NVS - afterwards
// there is nothing left to prove the request came from this device, and
// enrolment is one-time, so the unit comes back up unable to register and with
// no way to say so.
//
// Returns ESP_OK only when the server confirmed. A reset while offline has to
// carry on regardless: the owner can still release it from the dashboard.
esp_err_t net_unenroll(void);

typedef struct {
    bool claimed;
    char code[8];      // 6 digits, shown on screen
} claim_state_t;

// Asks for a claim code, or reports that the device already belongs to an
// account. The code is minted on demand and only ever shown on the device's own
// screen, so there is nothing on the packaging for anyone to harvest.
esp_err_t net_claim_begin(claim_state_t *out);

// Cheap poll used while the claim screen is up.
bool net_claim_is_claimed(void);

// Uploads captured PCM, then streams the spoken reply back through on_audio.
esp_err_t net_talk(const uint8_t *pcm, size_t pcm_len,
                   net_meta_cb on_meta, net_audio_cb on_audio, void *ctx);

#ifdef __cplusplus
}
#endif
