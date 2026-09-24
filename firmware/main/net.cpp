#include "net.h"
#include "config.h"
#include "app_config.h"

#include <string.h>
#include <strings.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_mac.h"

static const char *TAG = "net";

#define UPLOAD_CHUNK  4096
#define DOWNLOAD_CHUNK 4096

// How long the chunked body may go quiet before we give up. Must comfortably
// exceed the backend's TTS time (~7s for a two-sentence answer).
#define STREAM_STALL_US (45LL * 1000 * 1000)

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// The backend sends transcript/answer as percent-encoded header values, since
// HTTP headers cannot carry raw UTF-8.
static void url_decode(const char *src, char *dst, size_t dst_size)
{
    size_t o = 0;
    for (size_t i = 0; src[i] && o + 1 < dst_size; i++) {
        if (src[i] == '%' && src[i + 1] && src[i + 2]) {
            int hi = hexval(src[i + 1]), lo = hexval(src[i + 2]);
            if (hi >= 0 && lo >= 0) {
                dst[o++] = (char)((hi << 4) | lo);
                i += 2;
                continue;
            }
        }
        dst[o++] = src[i];
    }
    dst[o] = '\0';
}

// Used ONLY to request enrollment. The MAC is not a secret - it is broadcast in
// every beacon - so it must never authenticate anything on its own. After
// enrollment the backend derives identity from the token instead.
const char *net_device_id(void)
{
    static char id[13];
    if (id[0] == '\0') {
        uint8_t mac[6] = {0};
        esp_read_mac(mac, ESP_MAC_WIFI_STA);
        snprintf(id, sizeof(id), "%02x%02x%02x%02x%02x%02x",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }
    return id;
}

esp_err_t net_unenroll(void)
{
    const app_config_t *cfg = config_get();
    if (!cfg->device_token[0]) return ESP_OK;   // nothing registered to retire

    char url[sizeof(cfg->backend_url) + 12];
    snprintf(url, sizeof(url), "%s/unenroll", cfg->backend_url);

    esp_http_client_config_t hc = {};
    hc.url               = url;
    hc.method            = HTTP_METHOD_POST;
    hc.timeout_ms        = HTTP_TIMEOUT_MS;
    hc.crt_bundle_attach = esp_crt_bundle_attach;
    hc.buffer_size       = 1024;

    esp_http_client_handle_t c = esp_http_client_init(&hc);
    if (!c) return ESP_FAIL;

    char auth[128];
    snprintf(auth, sizeof(auth), "Bearer %s", cfg->device_token);
    esp_http_client_set_header(c, "Authorization", auth);
    esp_http_client_set_header(c, "Content-Length", "0");

    esp_err_t result = ESP_FAIL;
    if (esp_http_client_open(c, 0) != ESP_OK) {
        ESP_LOGW(TAG, "unenroll: connect failed - resetting anyway");
        goto out;
    }
    if (esp_http_client_fetch_headers(c) < 0) {
        ESP_LOGW(TAG, "unenroll: no response - resetting anyway");
        goto out;
    }
    {
        const int status = esp_http_client_get_status_code(c);
        if (status == 200) {
            ESP_LOGI(TAG, "unenrolled server-side - this device can register again");
            result = ESP_OK;
        } else {
            ESP_LOGW(TAG, "unenroll: HTTP %d - resetting anyway", status);
        }
    }

out:
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return result;
}

esp_err_t net_enroll(void)
{
    app_config_t cfg = *config_get();
    if (cfg.device_token[0]) return ESP_OK;   // already enrolled

    char url[sizeof(cfg.backend_url) + 8];
    snprintf(url, sizeof(url), "%s/enroll", cfg.backend_url);

    esp_http_client_config_t hc = {};
    hc.url               = url;
    hc.method            = HTTP_METHOD_POST;
    hc.timeout_ms        = HTTP_TIMEOUT_MS;
    hc.crt_bundle_attach = esp_crt_bundle_attach;
    hc.buffer_size       = 1024;

    esp_http_client_handle_t c = esp_http_client_init(&hc);
    if (!c) return ESP_FAIL;

    esp_http_client_set_header(c, "X-Api-Key", cfg.api_key);
    esp_http_client_set_header(c, "X-Device-Id", net_device_id());
    esp_http_client_set_header(c, "Content-Length", "0");

    esp_err_t result = ESP_FAIL;
    if (esp_http_client_open(c, 0) != ESP_OK) {
        ESP_LOGE(TAG, "enroll: connect failed");
        goto out;
    }
    if (esp_http_client_fetch_headers(c) < 0) {
        ESP_LOGE(TAG, "enroll: no response");
        goto out;
    }

    {
        int status = esp_http_client_get_status_code(c);
        if (status == 409) {
            // Someone - or a previous flash of this board - already enrolled
            // this id. Refusing re-enrollment is exactly what stops a stolen
            // bootstrap key being used to hijack a device already in the field,
            // so this is correct behaviour, not a failure to work around.
            ESP_LOGE(TAG, "enroll: device already enrolled; needs an admin release");
            goto out;
        }
        if (status != 200) {
            ESP_LOGE(TAG, "enroll: HTTP %d", status);
            goto out;
        }

        char body[256] = {0};
        int n = esp_http_client_read(c, body, sizeof(body) - 1);
        if (n <= 0) goto out;
        body[n] = '\0';

        // Response is {"token":"..."} - small and fixed-shape, so a scan beats
        // pulling in a JSON parser for one field.
        const char *k = strstr(body, "\"token\"");
        const char *s = k ? strchr(k + 7, '"') : NULL;
        const char *e = s ? strchr(s + 1, '"') : NULL;
        if (!s || !e || (size_t)(e - s - 1) >= sizeof(cfg.device_token)) {
            ESP_LOGE(TAG, "enroll: could not parse token");
            goto out;
        }
        memcpy(cfg.device_token, s + 1, e - s - 1);
        cfg.device_token[e - s - 1] = '\0';

        if (config_save(&cfg) == ESP_OK) {
            ESP_LOGI(TAG, "enrolled: per-device token stored");
            result = ESP_OK;
        }
    }

out:
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return result;
}

// Small authenticated POST returning a short JSON body. Shared by the claim
// endpoints, which are all the same shape.
static int post_authed(const char *suffix, char *body, size_t body_cap)
{
    const app_config_t *cfg = config_get();
    char url[sizeof(cfg->backend_url) + 32];
    snprintf(url, sizeof(url), "%s%s", cfg->backend_url, suffix);

    esp_http_client_config_t hc = {};
    hc.url               = url;
    hc.method            = HTTP_METHOD_POST;
    hc.timeout_ms        = HTTP_TIMEOUT_MS;
    hc.crt_bundle_attach = esp_crt_bundle_attach;
    hc.buffer_size       = 1024;

    esp_http_client_handle_t c = esp_http_client_init(&hc);
    if (!c) return -1;

    char auth[sizeof(cfg->device_token) + 8];
    snprintf(auth, sizeof(auth), "Bearer %s", cfg->device_token);
    esp_http_client_set_header(c, "Authorization", auth);
    esp_http_client_set_header(c, "Content-Length", "0");

    int status = -1;
    if (esp_http_client_open(c, 0) != ESP_OK) goto out;
    if (esp_http_client_fetch_headers(c) < 0) goto out;
    status = esp_http_client_get_status_code(c);
    if (body && body_cap) {
        int n = esp_http_client_read(c, body, body_cap - 1);
        body[n > 0 ? n : 0] = '\0';
    }
out:
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return status;
}

esp_err_t net_claim_begin(claim_state_t *out)
{
    memset(out, 0, sizeof(*out));
    char body[192] = {0};
    int status = post_authed("/claim/begin", body, sizeof(body));
    if (status != 200) {
        ESP_LOGE(TAG, "claim/begin -> HTTP %d", status);
        return ESP_FAIL;
    }
    if (strstr(body, "\"claimed\":true")) {
        out->claimed = true;
        return ESP_OK;
    }
    const char *k = strstr(body, "\"code\"");
    const char *s = k ? strchr(k + 6, '"') : NULL;
    const char *e = s ? strchr(s + 1, '"') : NULL;
    if (!s || !e || (size_t)(e - s - 1) >= sizeof(out->code)) return ESP_FAIL;
    memcpy(out->code, s + 1, e - s - 1);
    out->code[e - s - 1] = '\0';
    ESP_LOGI(TAG, "claim code %s", out->code);
    return ESP_OK;
}

bool net_claim_is_claimed(void)
{
    char body[128] = {0};
    if (post_authed("/claim/status", body, sizeof(body)) != 200) return false;
    return strstr(body, "\"claimed\":true") != NULL;
}

static esp_err_t http_event(esp_http_client_event_t *evt)
{
    if (evt->event_id != HTTP_EVENT_ON_HEADER) return ESP_OK;
    talk_meta_t *meta = (talk_meta_t *)evt->user_data;
    if (!meta) return ESP_OK;

    if (strcasecmp(evt->header_key, "X-Transcript") == 0) {
        url_decode(evt->header_value, meta->transcript, sizeof(meta->transcript));
    } else if (strcasecmp(evt->header_key, "X-Answer") == 0) {
        url_decode(evt->header_value, meta->answer, sizeof(meta->answer));
    }
    return ESP_OK;
}

esp_err_t net_talk(const uint8_t *pcm, size_t pcm_len,
                   net_meta_cb on_meta, net_audio_cb on_audio, void *ctx)
{
    talk_meta_t meta = {};
    esp_err_t result = ESP_FAIL;

    const app_config_t *ac = config_get();

    esp_http_client_config_t cfg = {};
    cfg.url              = ac->backend_url;
    cfg.method           = HTTP_METHOD_POST;
    cfg.timeout_ms       = HTTP_TIMEOUT_MS;
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
    cfg.event_handler    = http_event;
    cfg.user_data        = &meta;
    cfg.buffer_size      = 2048;
    cfg.buffer_size_tx   = 1024;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) return ESP_FAIL;

    esp_http_client_set_header(client, "Content-Type", "audio/L16;rate=16000;channels=1");

    // The per-device token is the ONLY thing that identifies this device. No
    // X-Device-Id is sent, and the backend would ignore it if it were: the
    // device id is looked up from the token, so identity cannot be asserted by
    // whoever is holding the microphone.
    char auth[sizeof(ac->device_token) + 8];
    snprintf(auth, sizeof(auth), "Bearer %s", ac->device_token);
    esp_http_client_set_header(client, "Authorization", auth);

    // The owner's Gemini key travels with each request rather than living in
    // Firestore. The backend uses it for this call and never persists it, so a
    // database leak exposes no keys - there are none stored to leak.
    if (ac->gemini_key[0]) {
        esp_http_client_set_header(client, "X-Gemini-Key", ac->gemini_key);
    }

    ESP_LOGI(TAG, "POST %zu bytes of audio", pcm_len);

    esp_err_t err = esp_http_client_open(client, pcm_len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "connect failed: %s", esp_err_to_name(err));
        goto done;
    }

    {
        size_t sent = 0;
        while (sent < pcm_len) {
            size_t n = pcm_len - sent;
            if (n > UPLOAD_CHUNK) n = UPLOAD_CHUNK;
            int w = esp_http_client_write(client, (const char *)pcm + sent, n);
            if (w <= 0) {
                ESP_LOGE(TAG, "upload aborted at %zu/%zu", sent, pcm_len);
                goto done;
            }
            sent += w;
        }
    }

    if (esp_http_client_fetch_headers(client) < 0) {
        ESP_LOGE(TAG, "no response headers");
        goto done;
    }

    {
        int status = esp_http_client_get_status_code(client);
        if (status != 200) {
            ESP_LOGE(TAG, "backend returned HTTP %d", status);
            goto done;
        }
        ESP_LOGI(TAG, "heard: \"%s\"", meta.transcript);
        ESP_LOGI(TAG, "reply: \"%s\"", meta.answer);
        if (on_meta) on_meta(&meta, ctx);

        uint8_t *buf = (uint8_t *)heap_caps_malloc(DOWNLOAD_CHUNK, MALLOC_CAP_DEFAULT);
        if (!buf) goto done;

        size_t total = 0;
        int64_t last_progress = esp_timer_get_time();
        int64_t first_byte_us = 0;

        while (true) {
            int r = esp_http_client_read(client, (char *)buf, DOWNLOAD_CHUNK);
            if (r < 0) {
                ESP_LOGE(TAG, "read error after %zu bytes", total);
                break;
            }
            if (r == 0) {
                // NOT necessarily EOF. The backend flushes headers as soon as
                // the answer text exists and only then starts generating
                // speech, so there is a multi-second window where the chunked
                // body is open but empty. Treating that as end-of-stream would
                // abort with zero audio and wipe the text we just displayed.
                if (esp_http_client_is_complete_data_received(client)) {
                    result = ESP_OK;
                    break;
                }
                if (esp_timer_get_time() - last_progress > STREAM_STALL_US) {
                    ESP_LOGE(TAG, "stream stalled after %zu bytes", total);
                    break;
                }
                vTaskDelay(pdMS_TO_TICKS(20));
                continue;
            }
            last_progress = esp_timer_get_time();
            if (first_byte_us == 0) first_byte_us = last_progress;
            total += r;
            if (on_audio && on_audio(buf, r, ctx) != ESP_OK) break;
        }
        // A chunked reply with no declared length still counts as success once
        // we have drained it and received some audio.
        if (result != ESP_OK && total > 0) result = ESP_OK;

        // first_byte_us marks when audio actually started flowing, so the
        // throughput figure excludes the several seconds the backend spends
        // generating speech before it sends anything.
        int64_t now = esp_timer_get_time();
        if (total > 0 && first_byte_us > 0 && now > first_byte_us) {
            double secs = (double)(now - first_byte_us) / 1000000.0;
            ESP_LOGI(TAG, "downloaded %zu bytes in %.1fs = %.1f KB/s "
                          "(playback needs %d KB/s)",
                     total, secs, total / 1024.0 / secs,
                     (AUDIO_SAMPLE_RATE * 2) / 1024);
        }
        free(buf);
    }

done:
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return result;
}
