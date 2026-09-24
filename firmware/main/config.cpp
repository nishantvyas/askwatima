#include "config.h"
#include "secrets.h"

#include <string.h>
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_log.h"
#include "esp_system.h"

static const char *TAG = "config";
static const char *NS = "watima";

static app_config_t s_cfg;

static void load_str(nvs_handle_t h, const char *key, char *dst, size_t cap, const char *fallback)
{
    size_t len = cap;
    if (nvs_get_str(h, key, dst, &len) != ESP_OK) {
        strncpy(dst, fallback ? fallback : "", cap - 1);
        dst[cap - 1] = '\0';
    }
}

esp_err_t config_init(void)
{
    memset(&s_cfg, 0, sizeof(s_cfg));

    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READONLY, &h);
    if (err != ESP_OK) {
        // Nothing stored yet. Seed from the compile-time values so a developer
        // unit keeps working straight after flashing; a blank SSID here just
        // means the device will come up in setup mode instead.
        ESP_LOGI(TAG, "no saved settings, using compiled-in defaults");
        strncpy(s_cfg.wifi_ssid, WIFI_SSID, sizeof(s_cfg.wifi_ssid) - 1);
        strncpy(s_cfg.wifi_pass, WIFI_PASSWORD, sizeof(s_cfg.wifi_pass) - 1);
        strncpy(s_cfg.backend_url, BACKEND_URL, sizeof(s_cfg.backend_url) - 1);
        strncpy(s_cfg.api_key, BACKEND_API_KEY, sizeof(s_cfg.api_key) - 1);
        return ESP_OK;
    }

    load_str(h, "wifi_ssid", s_cfg.wifi_ssid, sizeof(s_cfg.wifi_ssid), WIFI_SSID);
    load_str(h, "wifi_pass", s_cfg.wifi_pass, sizeof(s_cfg.wifi_pass), WIFI_PASSWORD);
    load_str(h, "gemini_key", s_cfg.gemini_key, sizeof(s_cfg.gemini_key), "");
    load_str(h, "backend_url", s_cfg.backend_url, sizeof(s_cfg.backend_url), BACKEND_URL);
    load_str(h, "api_key", s_cfg.api_key, sizeof(s_cfg.api_key), BACKEND_API_KEY);
    load_str(h, "dev_token", s_cfg.device_token, sizeof(s_cfg.device_token), "");
    nvs_close(h);

    ESP_LOGI(TAG, "loaded: ssid=\"%s\" backend=%s gemini_key=%s token=%s",
             s_cfg.wifi_ssid, s_cfg.backend_url,
             s_cfg.gemini_key[0] ? "set" : "(none)",
             s_cfg.device_token[0] ? "enrolled" : "(not enrolled)");
    return ESP_OK;
}

const app_config_t *config_get(void) { return &s_cfg; }

bool config_is_provisioned(void) { return s_cfg.wifi_ssid[0] != '\0'; }

esp_err_t config_save(const app_config_t *cfg)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;

    nvs_set_str(h, "wifi_ssid", cfg->wifi_ssid);
    nvs_set_str(h, "wifi_pass", cfg->wifi_pass);
    nvs_set_str(h, "gemini_key", cfg->gemini_key);
    nvs_set_str(h, "backend_url", cfg->backend_url);
    nvs_set_str(h, "api_key", cfg->api_key);
    nvs_set_str(h, "dev_token", cfg->device_token);

    err = nvs_commit(h);
    nvs_close(h);
    if (err == ESP_OK) {
        s_cfg = *cfg;
        ESP_LOGI(TAG, "saved settings for \"%s\"", cfg->wifi_ssid);
    }
    return err;
}

void config_clear_wifi(void)
{
    app_config_t cfg = *config_get();
    cfg.wifi_ssid[0] = '\0';
    cfg.wifi_pass[0] = '\0';
    if (config_save(&cfg) == ESP_OK) {
        ESP_LOGW(TAG, "wi-fi forgotten - rebooting into setup");
    }
    esp_restart();
}

void config_factory_reset(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_all(h);

        // Erasing is NOT enough on its own. config_init() falls back to the
        // compile-time WIFI_SSID whenever the key is missing, so a wiped device
        // came back up and quietly rejoined the network the firmware was built
        // against - not the owner's, the BUILDER's. The reset looked like it
        // worked, right up to the point it skipped setup entirely.
        //
        // Writing an explicit empty value makes the absence deliberate: the key
        // exists, it is blank, and no fallback applies.
        nvs_set_str(h, "wifi_ssid", "");
        nvs_set_str(h, "wifi_pass", "");

        nvs_commit(h);
        nvs_close(h);
    }
    ESP_LOGW(TAG, "factory reset - rebooting into setup");
    esp_restart();
}
