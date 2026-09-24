#pragma once
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Brings up Wi-Fi in station mode and blocks until we have an IP or the
// timeout expires.
esp_err_t wifi_connect_blocking(uint32_t timeout_ms);

bool wifi_is_connected(void);

#ifdef __cplusplus
}
#endif
