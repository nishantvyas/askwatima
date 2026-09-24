#include "wifi.h"
#include "config.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"

static const char *TAG = "wifi";

#define WIFI_BIT_CONNECTED BIT0
#define WIFI_BIT_FAILED    BIT1

static EventGroupHandle_t s_events;
static volatile bool s_connected = false;
static int s_retries = 0;
static const int kMaxRetries = 6;

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_connected = false;
        if (s_retries < kMaxRetries) {
            s_retries++;
            ESP_LOGW(TAG, "disconnected, retry %d/%d", s_retries, kMaxRetries);
            esp_wifi_connect();
        } else {
            xEventGroupSetBits(s_events, WIFI_BIT_FAILED);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "got ip " IPSTR, IP2STR(&e->ip_info.ip));
        s_retries = 0;
        s_connected = true;
        xEventGroupSetBits(s_events, WIFI_BIT_CONNECTED);
    }
}

bool wifi_is_connected(void) { return s_connected; }

esp_err_t wifi_connect_blocking(uint32_t timeout_ms)
{
    // esp_netif_init() and the default event loop are owned by app_main, since
    // the provisioning path needs them too and they may only be created once.
    s_events = xEventGroupCreate();
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &on_wifi_event, NULL, NULL));

    const app_config_t *ac = config_get();
    wifi_config_t wc = {};
    // memcpy with an explicit length rather than strncpy: these fields are
    // fixed-size byte arrays that do not require a terminator, and a 32-char
    // SSID would otherwise lose its last character.
    memcpy(wc.sta.ssid, ac->wifi_ssid, strnlen(ac->wifi_ssid, sizeof(wc.sta.ssid)));
    memcpy(wc.sta.password, ac->wifi_pass, strnlen(ac->wifi_pass, sizeof(wc.sta.password)));
    // Left as WIFI_AUTH_OPEN so an open or WEP network still associates; the
    // password we were given is used if the AP asks for one.
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    // MIN_MODEM lets the radio sleep between the AP's beacons and wake for
    // traffic addressed to us. It costs latency on the first packet after an
    // idle spell - roughly a beacon interval, so ~100ms - against a turn that
    // already takes about four seconds end to end.
    //
    // The device spends nearly all its life idle on a shelf, so the radio was
    // burning current continuously to save a hundred milliseconds on a request
    // that had not been made yet. Measured drain with each setting is in the
    // battery log; change this back only against numbers, not instinct.
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_MIN_MODEM));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "connecting to \"%s\"", ac->wifi_ssid);
    EventBits_t bits = xEventGroupWaitBits(s_events,
                                           WIFI_BIT_CONNECTED | WIFI_BIT_FAILED,
                                           pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(timeout_ms));

    if (bits & WIFI_BIT_CONNECTED) return ESP_OK;
    ESP_LOGE(TAG, "wifi connect failed");
    return ESP_FAIL;
}
