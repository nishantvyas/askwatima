// Watima - push-to-talk voice assistant for the Waveshare
// ESP32-S3-Touch-AMOLED-1.43C.
//
//   hold the screen -> LISTENING  (capture mic to PSRAM)
//   release         -> THINKING   (POST audio to the backend)
//   reply arrives   -> SPEAKING   (stream PCM to the speaker, show the text)
//
#include <stdio.h>
#include <string.h>
#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "lvgl.h"

#include "esp32_s3_touch_amoled_1.43c.h"
#include "bsp_config.h"
#include "button.h"

#include "app_config.h"
#include "audio.h"
#include "battery.h"
#include "config.h"
#include "net.h"
#include "ota.h"
#include "provision.h"
#include "ui.h"
#include "wifi.h"
#include "driver/gpio.h"
#include "esp_netif.h"
#include "esp_timer.h"

// Linker symbols for main/idle-default.jpg, listed under EMBED_FILES in
// main/CMakeLists.txt. The bytes sit in flash and are memory mapped, so they can
// be handed to LVGL directly - no copy, and they outlive every frame.
extern const uint8_t kIdleJpgStart[] asm("_binary_idle_default_jpg_start");
extern const uint8_t kIdleJpgEnd[] asm("_binary_idle_default_jpg_end");
#include "esp_event.h"

static const char *TAG = "watima";

typedef enum { EVT_PRESS } app_evt_t;

static QueueHandle_t s_evtq;
static volatile bool s_touch_down = false;
static volatile bool s_abort_play = false;
static bool s_playing = false;   // playback has begun for the current turn
static Button *s_boot_button = nullptr;

// --- input ---------------------------------------------------------------
// These run in the LVGL / button task. They only ever touch flags and the
// queue; all real work happens on the app task.

// --- idle, screensaver, sleep --------------------------------------------
static volatile int64_t s_last_active_us;
static bool s_saver_on;
static bool s_asleep;

// Called from the button task. Waking is done here rather than in the idle
// task so the panel is already lit by the time the press is handled - a child
// pressing a dark device should not watch it think about it first.
static void note_activity(void)
{
    s_last_active_us = esp_timer_get_time();
    if (s_asleep)   { ui_display_sleep(false); s_asleep = false; }
    if (s_saver_on) { ui_screensaver(false);   s_saver_on = false; }
}

static void idle_task(void *)
{
    int tick = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));

        // Every 30s, so the gauge tracks the clock rather than how often
        // somebody happens to open the settings screen.
        if (++tick % 30 == 0) battery_sample();

        // A turn in progress is activity even with nobody touching anything -
        // covering a reply with a galaxy halfway through would be absurd.
        if (ui_get_state() != UI_IDLE) {
            s_last_active_us = esp_timer_get_time();
            continue;
        }

        const int64_t idle_ms = (esp_timer_get_time() - s_last_active_us) / 1000;

        if (!s_saver_on && idle_ms >= UI_SCREENSAVER_AFTER_MS) {
            ui_screensaver(true);
            s_saver_on = true;
            ESP_LOGI(TAG, "idle - showing screensaver");
        }
        if (!s_asleep && idle_ms >= UI_SLEEP_AFTER_MS) {
            ui_display_sleep(true);
            s_asleep = true;
            ESP_LOGI(TAG, "idle - display asleep");
        }
    }
}

// --- settings ------------------------------------------------------------
static bool s_in_settings;

// Retiring the registration BEFORE wiping is the whole point: enrolment is
// one-time server-side, so a device that erases itself silently comes back
// unable to register. Offline it carries on anyway - the owner can still
// release it from the dashboard, and refusing to reset would be worse.
static void do_factory_reset(void)
{
    ESP_LOGW(TAG, "factory reset requested");
    // No ui_set_hint here: the confirm screen replaced the talk UI, so the hint
    // label no longer exists.
    net_unenroll();
    config_factory_reset();   // reboots
}

static void do_forget_wifi(void)
{
    ESP_LOGW(TAG, "wi-fi reset requested");
    config_clear_wifi();      // reboots into the QR setup portal
}

// Deferred out of the click that asked for it. Tearing the screen down from
// inside a button's own event handler frees that button mid-dispatch, and LVGL
// then walks back into it - which is precisely the panic this shipped with.
static void rebuild_talk_ui(void *unused)
{
    (void)unused;
    if (bsp_display_lock(-1) == ESP_OK) {
        ui_reset_screen();     // frees the widgets AND forgets the pointers
        ui_create();
        bsp_display_unlock();
    }
    ui_set_state(UI_IDLE);
    // The old screensaver object went with the screen; this makes a new one.
    ui_set_idle_image(kIdleJpgStart, (uint32_t)(kIdleJpgEnd - kIdleJpgStart));
    s_last_active_us = esp_timer_get_time();
    s_saver_on = false;
    s_in_settings = false;
}

static void close_settings(void)
{
    lv_async_call(rebuild_talk_ui, nullptr);
}

static void open_settings(void)
{
    if (s_in_settings) return;
    if (ui_get_state() == UI_THINKING || ui_get_state() == UI_SPEAKING) return;
    s_in_settings = true;

    static char ver[32];
    snprintf(ver, sizeof(ver), "Firmware %s", ota_running_version());

    static ui_settings_t s;
    s.wifi = config_get()->wifi_ssid[0] ? config_get()->wifi_ssid : NULL;
    s.version = ver;
    s.device_id = net_device_id();
    s.battery = battery_text();
    s.on_forget_wifi = do_forget_wifi;
    s.on_factory_reset = do_factory_reset;
    s.on_close = close_settings;
    ui_show_settings(&s);
}

static void begin_press(void)
{
    // In settings the button is not a microphone; the screen is driving.
    if (s_in_settings) return;

    note_activity();

    if (ui_get_state() == UI_SPEAKING) {
        // Pressing during a reply cuts it short. This used to be a tap on the
        // screen; with touch gone the button carries it, which is also the
        // gesture a child already knows.
        s_abort_play = true;
        return;
    }
    s_touch_down = true;
    app_evt_t ev = EVT_PRESS;
    xQueueSend(s_evtq, &ev, 0);
}

static void end_press(void) { s_touch_down = false; }

// Ends a turn. Clearing the queue alone is not enough: if the user pressed
// again while we were busy, begin_press() already set s_touch_down and the
// queued event is about to be discarded - leaving the flag stuck true with
// nothing to consume it, which silently swallows their next press. Drop both
// together so a new press always has to start from a clean release.
static void end_turn(void)
{
    s_touch_down = false;
    xQueueReset(s_evtq);
}


// --- response handling ---------------------------------------------------

// The backend flushes headers as soon as the text exists, several seconds
// before the speech audio is ready. Load the reply text now but stay in
// THINKING - flipping to SPEAKING here would show that label over silence.
static void on_meta(const talk_meta_t *m, void *ctx)
{
    (void)ctx;
    ui_set_answer(m->answer[0] ? m->answer : m->transcript);
    // Headers landing is a real milestone: the model has answered and only
    // speech synthesis remains. Move to the second stage and let the arc jump.
    ui_set_state(UI_COMPOSING);
    ui_progress_to(93, 11000);
}

// Buffer first, then speak once we have banked AUDIO_PREBUFFER_MS of audio,
// continuing to play as the rest streams in. A short reply lands complete
// before the threshold and just plays at the end; a long one starts talking
// after its first sentence instead of after the whole answer.
static esp_err_t on_audio(const uint8_t *data, size_t len, void *ctx)
{
    (void)ctx;
    if (s_abort_play) return ESP_FAIL;
    if (!audio_reply_append(data, len)) return ESP_FAIL;

    if (!s_playing && audio_reply_pending_ms() >= AUDIO_PREBUFFER_MS) {
        s_playing = true;
        ESP_LOGI(TAG, "prebuffered %" PRIu32 " ms, starting playback early",
                 audio_reply_pending_ms());
        ui_set_state(UI_SPEAKING);
    }
    if (s_playing) return audio_reply_play_pending(&s_abort_play);
    return ESP_OK;
}

// --- main loop -----------------------------------------------------------

static void app_task(void *arg)
{
    (void)arg;
    app_evt_t ev;

    while (true) {
        if (xQueueReceive(s_evtq, &ev, portMAX_DELAY) != pdTRUE) continue;
        if (ui_get_state() == UI_THINKING || ui_get_state() == UI_SPEAKING) continue;

        ui_set_state(UI_LISTENING);
        audio_record_reset();
        while (s_touch_down) {
            if (!audio_record_pump()) break;   // buffer full
        }

        uint32_t ms = audio_record_duration_ms();
        if (ms < AUDIO_MIN_RECORD_MS) {
            ESP_LOGI(TAG, "ignoring %" PRIu32 " ms tap", ms);
            ui_set_state(UI_IDLE);
            end_turn();
            continue;
        }

        ESP_LOGI(TAG, "captured %" PRIu32 " ms", ms);
        audio_record_log_levels();
        ui_set_answer("");
        ui_set_state(UI_THINKING);
        ui_progress_to(55, 7000);   // creeps while uploading and waiting
        s_abort_play = false;
        s_playing = false;
        audio_reply_reset();

        esp_err_t err = net_talk(audio_record_data(), audio_record_len(),
                                 on_meta, on_audio, nullptr);

        if (err == ESP_OK && audio_reply_len() > 0) {
            if (!s_playing) {           // short reply: never hit the prebuffer
                ESP_LOGI(TAG, "speaking %" PRIu32 " ms", audio_reply_duration_ms());
                ui_set_state(UI_SPEAKING);
            }
            audio_reply_play_pending(&s_abort_play);   // drain the remainder
        } else if (err != ESP_OK) {
            ESP_LOGE(TAG, "talk failed");
            ui_set_answer("");
            ui_set_state(UI_ERROR);
            vTaskDelay(pdMS_TO_TICKS(2500));
        }

        ui_set_state(UI_IDLE);
        end_turn();
    }
}

extern "C" void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    // Settings live in NVS so a device can be set up without a reflash.
    ESP_ERROR_CHECK(config_init());

    // Brings up I2C, the AMOLED panel, touch, and the LVGL task (core 1).
    bsp_broolesia_display_init();
    if (bsp_display_lock(-1) == ESP_OK) {
        ui_create();
        bsp_display_unlock();
    }
    ui_set_hint("starting up");

    ESP_ERROR_CHECK(audio_init());

#if RUN_MIC_PROBE
    // Bring-up aid: confirms which ES7210 slot is the microphone.
    audio_probe_channels();
#endif

    s_evtq = xQueueCreate(8, sizeof(app_evt_t));

    // Owned here rather than inside wifi.cpp or provision.cpp: both need them,
    // and they may only be created once per boot.
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    // Holding BOOT through startup forces setup mode even when the saved
    // network still works - the escape hatch for handing the device on, or
    // changing the Gemini key.
    gpio_set_direction(BUTTON_0_GPIO_PIN, GPIO_MODE_INPUT);
    gpio_set_pull_mode(BUTTON_0_GPIO_PIN, GPIO_PULLUP_ONLY);
    const bool forced_setup = (gpio_get_level(BUTTON_0_GPIO_PIN) == 0);
    if (forced_setup) ESP_LOGW(TAG, "BOOT held - entering setup");

    bool online = false;
    if (!forced_setup && config_is_provisioned()) {
        ui_set_hint("connecting to wifi");
        online = (wifi_connect_blocking(WIFI_CONNECT_TIMEOUT_MS) == ESP_OK);
    }

    if (!online) {
        // No credentials, or they no longer work. Either way the device cannot
        // reach anything remote, so setup has to happen over our own AP.
        ESP_LOGW(TAG, "not online - starting setup portal");
        ui_show_setup(provision_ap_ssid());
        ESP_ERROR_CHECK(provision_start());
        vTaskDelete(NULL);   // provisioning owns the device until it reboots
        return;
    }

    // First boot with network: trade the shared bootstrap key for a token that
    // belongs to this device alone. Enrollment is one-time server-side, so this
    // is a no-op on every later boot.
    if (!config_get()->device_token[0]) {
        ui_set_hint("registering device");
        if (net_enroll() != ESP_OK) {
            ESP_LOGE(TAG, "enrollment failed - cannot talk without a device token");
            ui_set_state(UI_ERROR);
            ui_set_hint("registration failed");
        }
    }

    // Firmware BEFORE pairing, deliberately, and both halves have to be here.
    //
    // These used to sit after the claim gate, which returns and deletes this
    // task while a device is unclaimed - so a device waiting to be paired never
    // checked for updates and never committed one. Two ways that bites:
    //
    //   A unit shipped with a bug in the claim or wi-fi path cannot fix itself,
    //   because reaching the fix requires getting past the thing that is broken.
    //   The devices you most need to reach are exactly the ones you cannot.
    //
    //   And an update applied while unclaimed boots pending-verify, never gets
    //   validated, and rolls back on the next restart - an update loop that
    //   never converges.
    //
    // Everything the health gates measure - audio, wi-fi, the display pipeline -
    // is already up by this point, so judging the image here is no weaker than
    // judging it later.
    ota_validate();

    xTaskCreate([](void *) {
        vTaskDelay(pdMS_TO_TICKS(20000));   // let the device settle first
        ota_check_and_apply();
        vTaskDelete(NULL);
    }, "otachk", 8 * 1024, nullptr, 3, nullptr);

    // The button is wired up BEFORE the claim gate, because the claim gate never
    // returns while a device is unpaired.
    //
    // Without this, a device showing a pairing code has no working input at all:
    // no settings, no way to forget the wi-fi it just joined, no way to reset.
    // A parent who typed the wrong network, or is pairing a second-hand unit
    // that still believes it is enrolled, has nowhere to go - the only escape is
    // holding BOOT while plugging in, which nobody would ever guess.
    //
    // Talking is still gated: begin_press() does nothing useful before the
    // device is claimed, and the backend would refuse it anyway.
    // Talking is the button and only the button. The screen used to start a
    // turn too, which meant a child resting a thumb on the glass, or setting the
    // device down face-up, began recording.
    //
    // Double press opens settings. Those two quick presses also fire the talk
    // path, but each is far shorter than AUDIO_MIN_RECORD_MS and is discarded as
    // a tap, so nothing is recorded or sent.
    s_boot_button = new Button(BUTTON_0_GPIO_PIN);
    s_boot_button->OnPressDown([]() { begin_press(); });
    s_boot_button->OnPressUp([]()   { end_press(); });
    s_boot_button->OnDoubleClick([]() { open_settings(); });

    // Claim gate. An unclaimed device has no verified parent, so the backend
    // refuses to transcribe anything for it - showing the pairing code and
    // waiting is the only useful thing it can do. Talking resumes after a
    // reboot, as a claimed device.
    {
        claim_state_t claim = {};
        if (net_claim_begin(&claim) == ESP_OK && !claim.claimed) {
            ui_show_claim(claim.code);
            xTaskCreate([](void *) {
                int elapsed = 0;
                while (true) {
                    vTaskDelay(pdMS_TO_TICKS(5000));
                    elapsed += 5;
                    if (net_claim_is_claimed()) {
                        ESP_LOGI(TAG, "device claimed - restarting");
                        vTaskDelay(pdMS_TO_TICKS(500));
                        esp_restart();
                    }
                    // Codes expire after 10 minutes; mint a fresh one just
                    // before that so the screen is never showing a dead code.
                    if (elapsed >= 9 * 60) {
                        claim_state_t next = {};
                        if (net_claim_begin(&next) == ESP_OK && !next.claimed) {
                            ui_show_claim(next.code);
                        }
                        elapsed = 0;
                    }
                }
            }, "claim", 6 * 1024, nullptr, 4, nullptr);
            vTaskDelete(NULL);   // nothing else to do until this device has an owner
            return;
        }
    }

    ui_set_state(UI_IDLE);

    // The default screensaver lives in the app image, so it is available on the
    // very first boot - before wi-fi, before an owner, before anything could be
    // downloaded. A parent's own upload replaces it from SPIFFS later.
    ui_set_idle_image(kIdleJpgStart, (uint32_t)(kIdleJpgEnd - kIdleJpgStart));

    s_last_active_us = esp_timer_get_time();
    xTaskCreate(idle_task, "idle", 3 * 1024, nullptr, 2, nullptr);

    // Seeds the smoothed reading and puts the pack voltage in the log.
    battery_sample();

    // The button, ota_validate() and the update check all live above the claim
    // gate now, so that a device waiting to be paired still has working input
    // and still updates itself.

    // LVGL owns core 1; keep the network/audio work on core 0.
    xTaskCreatePinnedToCore(app_task, "app", 12 * 1024, nullptr, 5, nullptr, 0);
    ESP_LOGI(TAG, "watima ready (fw %s)", ota_running_version());
}
