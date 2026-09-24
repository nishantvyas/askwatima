#pragma once
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Runtime settings, held in NVS rather than compiled in, so a device can be
// handed to someone else and set up without a reflash.
typedef struct {
    char wifi_ssid[33];    // 802.11 caps SSIDs at 32 bytes
    char wifi_pass[65];    // WPA2 passphrase caps at 63
    char gemini_key[160];  // the owner's own Gemini key - never stored server-side
    char backend_url[160];

    // Bootstrap key, identical on every unit. Used ONCE, to enroll. It is a
    // plaintext string in every shipped binary and must never be treated as a
    // device identity.
    char api_key[96];

    // Per-device token issued at enrollment. This is what actually
    // authenticates conversations, and the backend derives the device identity
    // from it - so a stolen token compromises exactly one device, and can be
    // revoked without touching any other.
    char device_token[96];
} app_config_t;

esp_err_t config_init(void);

// Returns the in-memory copy; always valid after config_init().
const app_config_t *config_get(void);

esp_err_t config_save(const app_config_t *cfg);

// True once we have at least an SSID to try.
bool config_is_provisioned(void);

// Forgets the wi-fi credentials ONLY, keeping the device token and its pairing,
// then reboots into the setup portal. This is what a parent wants when the
// router changes - the device stays theirs, stays claimed, and keeps its
// history. A full factory reset is a different and much heavier thing.
void config_clear_wifi(void);

// Wipes NVS settings and reboots into setup mode.
//
// Call net_unenroll() FIRST whenever the device is online. This throws away the
// per-device token, and enrolment is one-time server-side, so a device that
// erases itself without telling the backend comes back up unable to register -
// recoverable only by the owner pressing Remove device in the dashboard, which
// nothing prompts them to do. net_unenroll() is what keeps the two ends in step.
void config_factory_reset(void);

#ifdef __cplusplus
}
#endif
