// SoftAP setup portal.
//
// Wi-Fi provisioning has to be local: a device with no working network cannot
// reach a remote config service, so the bootstrap has to happen over a network
// the device itself provides.
//
// The owner joins "Watima-Setup-XXXX", their phone's captive-portal check hits
// our DNS hijack, and the setup page opens by itself.

#include "provision.h"
#include "config.h"

#include <string.h>
#include <stdlib.h>
#include <lwip/sockets.h>
#include <lwip/netdb.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_system.h"

static const char *TAG = "provision";

static char s_ap_ssid[32];
static httpd_handle_t s_server;

const char *provision_ap_ssid(void)
{
    if (s_ap_ssid[0] == '\0') {
        uint8_t mac[6] = {0};
        esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
        snprintf(s_ap_ssid, sizeof(s_ap_ssid), "Watima-Setup-%02X%02X", mac[4], mac[5]);
    }
    return s_ap_ssid;
}

// --- tiny helpers --------------------------------------------------------

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void form_decode(const char *src, char *dst, size_t cap)
{
    size_t o = 0;
    for (size_t i = 0; src[i] && o + 1 < cap; i++) {
        if (src[i] == '+') {
            dst[o++] = ' ';
        } else if (src[i] == '%' && src[i + 1] && src[i + 2]) {
            int hi = hexval(src[i + 1]), lo = hexval(src[i + 2]);
            if (hi >= 0 && lo >= 0) { dst[o++] = (char)((hi << 4) | lo); i += 2; continue; }
            dst[o++] = src[i];
        } else {
            dst[o++] = src[i];
        }
    }
    dst[o] = '\0';
}

// Pulls one field out of an application/x-www-form-urlencoded body.
static void form_field(const char *body, const char *name, char *out, size_t cap)
{
    out[0] = '\0';
    size_t nlen = strlen(name);
    for (const char *p = body; p && *p;) {
        const char *eq = strchr(p, '=');
        if (!eq) break;
        const char *amp = strchr(eq, '&');
        if ((size_t)(eq - p) == nlen && strncmp(p, name, nlen) == 0) {
            size_t vlen = amp ? (size_t)(amp - eq - 1) : strlen(eq + 1);
            char *raw = (char *)malloc(vlen + 1);
            if (raw) {
                memcpy(raw, eq + 1, vlen);
                raw[vlen] = '\0';
                form_decode(raw, out, cap);
                free(raw);
            }
            return;
        }
        if (!amp) break;
        p = amp + 1;
    }
}

static void html_escape(const char *src, char *dst, size_t cap)
{
    size_t o = 0;
    for (size_t i = 0; src[i] && o + 7 < cap; i++) {
        switch (src[i]) {
            case '<': memcpy(dst + o, "&lt;", 4);   o += 4; break;
            case '>': memcpy(dst + o, "&gt;", 4);   o += 4; break;
            case '&': memcpy(dst + o, "&amp;", 5);  o += 5; break;
            case '"': memcpy(dst + o, "&quot;", 6); o += 6; break;
            default:  dst[o++] = src[i];
        }
    }
    dst[o] = '\0';
}

// --- pages ---------------------------------------------------------------

static const char kPageHead[] =
    "<!doctype html><html><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>Watima setup</title><style>"
    "body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#111;color:#eee;"
    "margin:0;padding:24px;max-width:420px;margin:auto}"
    "h1{font-size:22px;margin:8px 0 4px}p.s{color:#8a8f98;margin:0 0 20px;font-size:14px}"
    "label{display:block;margin:14px 0 4px;font-size:13px;color:#9aa0aa}"
    "input,select{width:100%;box-sizing:border-box;padding:11px;border-radius:9px;"
    "border:1px solid #333;background:#1b1b1e;color:#eee;font-size:16px}"
    "button{width:100%;margin-top:22px;padding:13px;border:0;border-radius:9px;"
    "background:#4C7DF0;color:#fff;font-size:16px;font-weight:600}"
    "small{color:#6b7280;display:block;margin-top:6px;font-size:12px}"
    "</style></head><body>";

static esp_err_t root_get(httpd_req_t *req)
{
    // Scan on page load so the list is current; APSTA lets us scan while the
    // setup AP stays up.
    uint16_t count = 0;
    wifi_ap_record_t *aps = NULL;
    wifi_scan_config_t scan = {};
    scan.show_hidden = false;
    if (esp_wifi_scan_start(&scan, true) == ESP_OK) {
        esp_wifi_scan_get_ap_num(&count);
        if (count > 20) count = 20;
        if (count) {
            aps = (wifi_ap_record_t *)calloc(count, sizeof(wifi_ap_record_t));
            if (aps) esp_wifi_scan_get_ap_records(&count, aps);
        }
    }

    const app_config_t *cfg = config_get();
    httpd_resp_set_type(req, "text/html");
    httpd_resp_sendstr_chunk(req, kPageHead);
    httpd_resp_sendstr_chunk(req,
        "<h1>Watima setup</h1><p class=s>Connect your Watima to Wi-Fi.</p>"
        "<form method=POST action=/save><label>Wi-Fi network</label><select name=ssid>");

    char esc[128], row[320];
    bool listed = false;
    for (int i = 0; i < count; i++) {
        const char *ssid = (const char *)aps[i].ssid;
        if (!ssid[0]) continue;
        // The radio is 2.4GHz only; a 5GHz-only network would never connect.
        html_escape(ssid, esc, sizeof(esc));
        snprintf(row, sizeof(row), "<option value=\"%s\"%s>%s (%d dBm)</option>",
                 esc, strcmp(ssid, cfg->wifi_ssid) == 0 ? " selected" : "", esc, aps[i].rssi);
        httpd_resp_sendstr_chunk(req, row);
        listed = true;
    }
    free(aps);
    if (!listed) httpd_resp_sendstr_chunk(req, "<option value=\"\">(no networks found)</option>");

    httpd_resp_sendstr_chunk(req,
        "</select><small>2.4 GHz only - 5 GHz networks will not appear.</small>"
        "<label>Wi-Fi password</label><input name=pass type=password autocomplete=off>");

    // The Gemini key field used to live here. It is gone: inference runs on our
    // Vertex account, the backend ignores any key the device sends, and asking a
    // parent for one on an open unauthenticated access point was the worst place
    // in the product to collect a credential.
    httpd_resp_sendstr_chunk(req, "<button type=submit>Save and restart</button></form></body></html>");
    httpd_resp_sendstr_chunk(req, NULL);
    return ESP_OK;
}

static void reboot_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(1200));   // let the response reach the browser
    esp_restart();
}

static esp_err_t save_post(httpd_req_t *req)
{
    int len = req->content_len;
    if (len <= 0 || len > 2048) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad body");
        return ESP_FAIL;
    }
    char *body = (char *)calloc(1, len + 1);
    if (!body) return ESP_FAIL;

    int got = 0;
    while (got < len) {
        int r = httpd_req_recv(req, body + got, len - got);
        if (r <= 0) { free(body); return ESP_FAIL; }
        got += r;
    }

    app_config_t cfg = *config_get();
    form_field(body, "ssid", cfg.wifi_ssid, sizeof(cfg.wifi_ssid));
    form_field(body, "pass", cfg.wifi_pass, sizeof(cfg.wifi_pass));

    // Blank means "keep what is already stored" - the form never shows the
    // current key, so a blank submit must not wipe it.
    free(body);

    if (cfg.wifi_ssid[0] == '\0') {
        httpd_resp_set_type(req, "text/html");
        httpd_resp_sendstr(req, "<body style='font:16px sans-serif;padding:24px'>"
                                "Please choose a network. <a href=/>Back</a></body>");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "saving settings for \"%s\"", cfg.wifi_ssid);
    config_save(&cfg);

    httpd_resp_set_type(req, "text/html");
    httpd_resp_sendstr(req,
        "<body style='font:16px/1.6 -apple-system,sans-serif;background:#111;color:#eee;padding:32px'>"
        "<h2>Saved</h2><p>Watima is restarting and will join your network.</p>"
        "<p style='color:#8a8f98;font-size:14px'>If it comes back to this setup page, "
        "the password was probably wrong.</p></body>");

    xTaskCreate(reboot_task, "reboot", 2048, NULL, 5, NULL);
    return ESP_OK;
}

// Anything else IS the setup page, served directly rather than redirected.
//
// A 302 is the obvious answer and it is the less reliable one. iOS fetches
// /hotspot-detect.html and decides purely on what comes back: the literal word
// "Success" means the network is open, anything else means show the portal. It
// does follow redirects, but it also caches aggressively and gives up quickly,
// which is how a setup page ends up appearing minutes late or only once the
// user goes looking for it in Settings. Answering with the page itself removes
// the extra round trip and the chance to lose it.
static esp_err_t catch_all(httpd_req_t *req)
{
    return root_get(req);
}

// --- DNS hijack ----------------------------------------------------------
// Answers every A query with 192.168.4.1 so the phone's connectivity check
// resolves to us.

static void dns_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) { vTaskDelete(NULL); return; }

    struct sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(53);
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(sock);
        vTaskDelete(NULL);
        return;
    }

    uint8_t buf[256];
    while (true) {
        struct sockaddr_in from = {};
        socklen_t flen = sizeof(from);
        int n = recvfrom(sock, buf, sizeof(buf), 0, (struct sockaddr *)&from, &flen);
        if (n < 12) continue;

        // Reply: same header/question, one A record pointing at us.
        buf[2] |= 0x80;          // QR = response
        buf[3] |= 0x80;          // recursion available
        buf[7] = 1;              // ANCOUNT = 1
        buf[8] = buf[9] = 0;     // NSCOUNT
        buf[10] = buf[11] = 0;   // ARCOUNT

        if (n + 16 > (int)sizeof(buf)) continue;
        uint8_t *a = buf + n;
        *a++ = 0xC0; *a++ = 0x0C;                     // pointer to the question name
        *a++ = 0x00; *a++ = 0x01;                     // type A
        *a++ = 0x00; *a++ = 0x01;                     // class IN
        *a++ = 0; *a++ = 0; *a++ = 0; *a++ = 60;      // TTL 60s
        *a++ = 0x00; *a++ = 0x04;                     // RDLENGTH
        *a++ = 192; *a++ = 168; *a++ = 4; *a++ = 1;   // 192.168.4.1

        sendto(sock, buf, a - buf, 0, (struct sockaddr *)&from, flen);
    }
}

// --- entry ---------------------------------------------------------------

esp_err_t provision_start(void)
{
    const char *ssid = provision_ap_ssid();
    ESP_LOGI(TAG, "starting setup portal on \"%s\" (http://192.168.4.1)", ssid);

    // This runs in TWO different states and must survive both:
    //
    //   1. First boot, nothing configured. Nothing has touched wi-fi yet.
    //   2. A saved network that would not connect - a changed router password,
    //      most often - where wifi_connect_blocking() has ALREADY created the
    //      station interface and started the driver before giving up.
    //
    // In state 2 the old code created the same interfaces again. The second
    // esp_netif_create_default_wifi_sta() returns a duplicate if_key error, the
    // ESP_ERROR_CHECK aborted, and the device rebooted - straight back into the
    // failing network, and round again. A wrong password produced an endless
    // reboot loop instead of the setup screen it had correctly decided to show.
    //
    // So: stop whatever is running, reuse the interfaces that already exist, and
    // only create what is missing.
    esp_wifi_stop();          // no-op and harmless if the driver never started

    esp_netif_t *ap_netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if (!ap_netif) esp_netif_create_default_wifi_ap();

    esp_netif_t *sta_netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (!sta_netif) esp_netif_create_default_wifi_sta();   // needed so we can scan

    // Already-initialised is a valid state here, not a failure.
    wifi_init_config_t ic = WIFI_INIT_CONFIG_DEFAULT();
    esp_err_t err = esp_wifi_init(&ic);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) ESP_ERROR_CHECK(err);

    wifi_config_t ap = {};
    size_t slen = strnlen(ssid, sizeof(ap.ap.ssid));
    memcpy(ap.ap.ssid, ssid, slen);
    ap.ap.ssid_len = slen;
    ap.ap.channel = 1;
    ap.ap.max_connection = 4;
    ap.ap.authmode = WIFI_AUTH_OPEN;   // open, so joining is one tap on any phone

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    ESP_ERROR_CHECK(esp_wifi_start());

    httpd_config_t hc = HTTPD_DEFAULT_CONFIG();
    hc.lru_purge_enable = true;
    hc.uri_match_fn = httpd_uri_match_wildcard;
    hc.stack_size = 8192;
    ESP_ERROR_CHECK(httpd_start(&s_server, &hc));

    httpd_uri_t u_root = { "/", HTTP_GET, root_get, NULL };
    httpd_uri_t u_save = { "/save", HTTP_POST, save_post, NULL };
    httpd_uri_t u_any  = { "/*", HTTP_GET, catch_all, NULL };
    httpd_register_uri_handler(s_server, &u_root);
    httpd_register_uri_handler(s_server, &u_save);
    httpd_register_uri_handler(s_server, &u_any);

    xTaskCreate(dns_task, "dns", 3072, NULL, 4, NULL);
    return ESP_OK;
}
