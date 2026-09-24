#pragma once
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Brings up the "Watima-Setup-XXXX" access point and a captive portal on
// 192.168.4.1. Blocks until the owner submits settings, at which point the
// device saves them and reboots. Never returns in the normal case.
esp_err_t provision_start(void);

// SSID of the setup network, valid after provision_start() (or before it, for
// showing on screen).
const char *provision_ap_ssid(void);

#ifdef __cplusplus
}
#endif
