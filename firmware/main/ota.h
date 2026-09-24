#pragma once
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Decides whether the build now running is allowed to keep running.
//
// Call ONCE, late in app_main, after the display, codecs and network have been
// brought up - the gates need real subsystems to test. If the running image is
// still provisional and fails a hard gate, this reboots into the previous
// build and does not return.
esp_err_t ota_validate(void);

// Asks the backend whether a newer build applies to this device and installs it
// if so. Reboots on success and does not return.
//
// Refuses unless the device is idle: a flash write stops the world for tens of
// milliseconds at a time, which would mangle a conversation in progress.
esp_err_t ota_check_and_apply(void);

// Version string from the running image's esp_app_desc_t.
const char *ota_running_version(void);

#ifdef __cplusplus
}
#endif
