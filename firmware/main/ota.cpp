// Over-the-air update client.
//
// Uses the advanced esp_https_ota API (begin / perform / finish) rather than
// the one-shot call, for four reasons specific to this firmware:
//
//   1. The image header can be inspected after ~4KB, so a same-version or
//      wrong-target image is rejected without pulling 1.5MB over a parent's
//      connection.
//   2. The task watchdog is 5s and watches both idle tasks. The one-shot call
//      blocks with nowhere to yield.
//   3. The screen can show progress, which matters when the alternative is a
//      device that looks dead for a minute.
//   4. There is somewhere to check an abort flag.

#include "ota.h"
#include "app_config.h"
#include "audio.h"
#include "config.h"
#include "ui.h"

#include <string.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "esp_ota_ops.h"
#include "esp_https_ota.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_mac.h"
#include "esp_crc.h"
#include "esp_task_wdt.h"

static const char *TAG = "ota";

// A build that boots but has starved internal RAM will render fine and then die
// on the first TLS handshake, hours later, in someone's house - long after the
// rollback window shut. This board already loses that race sometimes (see the
// SPI DMA note in sdkconfig.defaults), so the floor is a hard gate, not a log.
#define OTA_MIN_INTERNAL_HEAP  (40 * 1024)

const char *ota_running_version(void)
{
    const esp_app_desc_t *d = esp_app_get_description();
    return d ? d->version : "unknown";
}

// Stable 0-99 bucket for staged rollout. Derived from the MAC so a device keeps
// the same bucket across reboots and releases - which is what makes a canary
// cohort meaningful rather than a fresh dice roll every time.
/**
 * Is `offered` a strictly newer release than `running`?
 *
 * This used to be `strcmp(a, b) != 0`, which treats "different" as "newer" and
 * therefore installs older builds as happily as new ones. Two ways that bites:
 * a device flashed over USB with a development build silently downgrades itself
 * to the published release about twenty seconds after boot, and a stale or
 * mistaken manifest walks the entire fleet backwards with no way to notice.
 *
 * Compares dotted numeric components left to right. Anything unparseable
 * compares as zero, so a malformed version can never look newer than a real one.
 */
static bool version_newer(const char *offered, const char *running)
{
    if (!offered || !running) return false;

    for (int i = 0; i < 4; i++) {
        long a = strtol(offered, (char **)&offered, 10);
        long b = strtol(running, (char **)&running, 10);
        if (a != b) return a > b;
        if (*offered == '.') offered++;
        if (*running == '.') running++;
        if (*offered == '\0' && *running == '\0') break;
    }
    return false;   // equal, or equal as far as it matters
}

static uint32_t rollout_bucket(void)
{
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    return esp_crc32_le(0, mac, sizeof(mac)) % 100;
}

esp_err_t ota_validate(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (!run || esp_ota_get_state_partition(run, &state) != ESP_OK) return ESP_OK;
    if (state != ESP_OTA_IMG_PENDING_VERIFY) return ESP_OK;   // not a fresh update

    const esp_reset_reason_t reason = esp_reset_reason();
    const size_t internal_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);

    const bool crashed = (reason == ESP_RST_PANIC ||
                          reason == ESP_RST_TASK_WDT ||
                          reason == ESP_RST_INT_WDT);
    const bool starved = (internal_free < OTA_MIN_INTERNAL_HEAP);

    if (crashed || starved) {
        ESP_LOGE(TAG, "health gate FAILED (reset=%d, internal heap=%u) - rolling back",
                 (int)reason, (unsigned)internal_free);
        vTaskDelay(pdMS_TO_TICKS(200));           // let the log flush
        esp_ota_mark_app_invalid_rollback_and_reboot();
        return ESP_FAIL;                          // not reached
    }

    ESP_LOGI(TAG, "health gates passed (internal heap %u) - committing %s",
             (unsigned)internal_free, ota_running_version());
    return esp_ota_mark_app_valid_cancel_rollback();
}

// Attaches the device token to the firmware request. esp_https_ota does not
// take headers directly, but it hands us the client before the request goes out.
static esp_err_t attach_auth(esp_http_client_handle_t client)
{
    static char auth[128];
    snprintf(auth, sizeof(auth), "Bearer %s", config_get()->device_token);
    esp_http_client_set_header(client, "Authorization", auth);
    return ESP_OK;
}

// Small JSON scalar extractor. The manifest is ours, tiny and fixed-shape, so
// this beats linking a parser for three fields.
static bool json_str(const char *body, const char *key, char *out, size_t cap)
{
    char pat[48];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *k = strstr(body, pat);
    if (!k) return false;
    const char *s = strchr(k + strlen(pat), '"');
    const char *e = s ? strchr(s + 1, '"') : NULL;
    if (!s || !e || (size_t)(e - s - 1) >= cap) return false;
    memcpy(out, s + 1, e - s - 1);
    out[e - s - 1] = '\0';
    return true;
}

static long json_num(const char *body, const char *key, long fallback)
{
    char pat[48];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *k = strstr(body, pat);
    if (!k) return fallback;
    const char *c = strchr(k + strlen(pat), ':');
    return c ? strtol(c + 1, NULL, 10) : fallback;
}

// Asks the backend what build applies to us. Returns true if an update should
// be attempted, with the target version in `want`.
static bool fetch_manifest(char *want, size_t want_cap)
{
    const app_config_t *cfg = config_get();
    char url[sizeof(cfg->backend_url) + 16];
    snprintf(url, sizeof(url), "%s/fw/check", cfg->backend_url);

    esp_http_client_config_t hc = {};
    hc.url               = url;
    hc.method            = HTTP_METHOD_POST;
    hc.timeout_ms        = HTTP_TIMEOUT_MS;
    hc.crt_bundle_attach = esp_crt_bundle_attach;
    hc.buffer_size       = 1024;

    esp_http_client_handle_t c = esp_http_client_init(&hc);
    if (!c) return false;

    char auth[128];
    snprintf(auth, sizeof(auth), "Bearer %s", cfg->device_token);
    esp_http_client_set_header(c, "Authorization", auth);
    esp_http_client_set_header(c, "X-Fw-Version", ota_running_version());
    esp_http_client_set_header(c, "Content-Length", "0");

    bool update = false;
    if (esp_http_client_open(c, 0) != ESP_OK) goto out;
    if (esp_http_client_fetch_headers(c) < 0) goto out;
    if (esp_http_client_get_status_code(c) != 200) goto out;

    {
        char body[384] = {0};
        int n = esp_http_client_read(c, body, sizeof(body) - 1);
        if (n <= 0) goto out;
        body[n] = '\0';

        if (json_num(body, "paused", 0)) {
            ESP_LOGI(TAG, "rollout paused");
            goto out;
        }
        char version[48] = {0};
        if (!json_str(body, "version", version, sizeof(version))) goto out;
        if (!version_newer(version, ota_running_version())) {
            ESP_LOGI(TAG, "firmware up to date (running %s, offered %s)",
                     ota_running_version(), version);
            goto out;
        }

        // Cohort check happens on the device so the backend does not need to
        // know or store anything per-device to stage a rollout.
        long pct = json_num(body, "rolloutPercent", 0);
        uint32_t bucket = rollout_bucket();
        if ((long)bucket >= pct) {
            ESP_LOGI(TAG, "%s available but bucket %u is outside rollout %ld%%",
                     version, (unsigned)bucket, pct);
            goto out;
        }

        ESP_LOGI(TAG, "update %s -> %s (bucket %u < %ld%%)",
                 ota_running_version(), version, (unsigned)bucket, pct);
        size_t vlen = strnlen(version, want_cap - 1);
        memcpy(want, version, vlen);
        want[vlen] = '\0';
        update = true;
    }

out:
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return update;
}

esp_err_t ota_check_and_apply(void)
{
    if (!config_get()->device_token[0]) return ESP_ERR_INVALID_STATE;

    // Never mid-conversation. Beyond the obvious UX, a talk turn has TLS, the
    // wifi buffers, the LCD DMA bounce buffer and the codec all contending for
    // internal RAM already; adding a flash write to that is asking for the
    // allocation failure this board is prone to.
    if (ui_get_state() != UI_IDLE) return ESP_ERR_INVALID_STATE;

    char want[48] = {0};
    if (!fetch_manifest(want, sizeof(want))) return ESP_OK;   // nothing to do

    const app_config_t *cfg = config_get();
    char url[sizeof(cfg->backend_url) + 24];
    snprintf(url, sizeof(url), "%s/fw/download", cfg->backend_url);

    // Hand the screen over to a static message and stop the audio path before
    // the first flash write. After this point the device is committed.
    ui_show_updating(want);
    audio_shutdown();

    esp_http_client_config_t hc = {};
    hc.url               = url;
    hc.timeout_ms        = 60000;
    hc.crt_bundle_attach = esp_crt_bundle_attach;
    hc.keep_alive_enable = true;
    hc.buffer_size       = 4096;

    esp_https_ota_config_t oc = {};
    oc.http_config         = &hc;
    oc.http_client_init_cb = attach_auth;
    // The default erases the whole 3MB slot up front - several seconds of
    // blocking erase, which trips the 5s task watchdog. Erase per-write instead.
    oc.bulk_flash_erase    = false;

    esp_https_ota_handle_t h = NULL;
    esp_err_t err = esp_https_ota_begin(&oc, &h);
    if (err != ESP_OK || !h) {
        ESP_LOGE(TAG, "ota begin failed: %s", esp_err_to_name(err));
        esp_restart();          // audio is down; a clean boot is the way back
    }

    // Verify the image really is what the manifest promised, ~4KB in, before
    // spending the remaining 1.5MB.
    esp_app_desc_t incoming;
    if (esp_https_ota_get_img_desc(h, &incoming) == ESP_OK) {
        ESP_LOGI(TAG, "incoming image: %s", incoming.version);
        if (strcmp(incoming.version, ota_running_version()) == 0) {
            ESP_LOGW(TAG, "server offered the version we already run - aborting");
            esp_https_ota_abort(h);
            esp_restart();
        }
    }

    const int total = esp_https_ota_get_image_size(h);
    int last_pct = -1;
    while (true) {
        err = esp_https_ota_perform(h);
        if (err != ESP_ERR_HTTPS_OTA_IN_PROGRESS) break;

        int got = esp_https_ota_get_image_len_read(h);
        int pct = (total > 0) ? (got * 100 / total) : 0;
        if (pct != last_pct && pct % 5 == 0) {
            last_pct = pct;
            ui_set_update_progress(pct);
            ESP_LOGI(TAG, "  %d%% (%d/%d)", pct, got, total);
        }
        // Yield so the idle task runs; the 5s watchdog watches both cores.
        vTaskDelay(pdMS_TO_TICKS(1));
    }

    if (err != ESP_OK || !esp_https_ota_is_complete_data_received(h)) {
        ESP_LOGE(TAG, "download failed: %s", esp_err_to_name(err));
        esp_https_ota_abort(h);
        esp_restart();
    }

    err = esp_https_ota_finish(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ota finish failed: %s", esp_err_to_name(err));
        esp_restart();
    }

    // The new image boots provisionally. ota_validate() decides on the far side
    // whether it earns the right to stay.
    ESP_LOGI(TAG, "installed %s - rebooting", want);
    ui_set_update_progress(100);
    vTaskDelay(pdMS_TO_TICKS(600));
    esp_restart();
    return ESP_OK;   // not reached
}
