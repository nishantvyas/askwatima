#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    UI_IDLE,
    UI_LISTENING,
    UI_THINKING,    // uploading + waiting for the model to answer
    UI_COMPOSING,   // answer text is in; speech is being generated
    UI_SPEAKING,
    UI_ERROR,
} ui_state_t;

// Builds the widget tree. The caller must already hold the display lock.
void ui_create(void);

// Deletes every widget on the screen AND forgets the pointers to them.
//
// Always use this instead of lv_obj_clean(). This module caches widget
// pointers, and lv_obj_clean() frees the objects without touching those - the
// next use is then a write through a dangling pointer, which is a panic several
// steps away from the code that caused it.
//
// Caller must hold the display lock. Never call it from inside an LVGL event
// callback: the widget dispatching that event is one of the ones being freed.
// Defer with lv_async_call().
void ui_reset_screen(void);

// Thread-safe: each takes the display lock itself. Never call these from an
// LVGL event callback - post to the app queue instead.
void ui_set_state(ui_state_t s);
void ui_set_answer(const char *text);
void ui_set_hint(const char *text);

// Creeps the progress arc toward `pct` over `ms`. Each stage aims at its own
// ceiling and never reaches it, so the ring keeps moving for as long as the
// stage lasts and jumps forward the moment the next real event arrives - the
// arc reflects actual progress rather than a fabricated timer.
void ui_progress_to(int pct, uint32_t ms);

// Replaces the normal UI with setup instructions and a QR code that joins the
// device's own network. Most headless gadgets make you find a sticker; this one
// has a screen, so it can just show you.
void ui_show_setup(const char *ap_ssid);

// Static update screen. Replaces the talk UI entirely and animates nothing:
// during an OTA the cache is repeatedly disabled for flash writes, so the less
// the display pipeline is doing, the fewer ways there are to go wrong.
// Shows the pairing code. Large, because a parent reads it off a 1.43" screen
// and types it into a browser on another device.
void ui_show_claim(const char *code);

void ui_show_updating(const char *version);
void ui_set_update_progress(int pct);

// Supplies the screensaver picture from JPEG bytes already in memory.
// `jpeg` must stay valid for as long as it may be displayed - LVGL decodes
// lazily and re-reads the source on redraw, so a stack buffer or a freed heap
// block shows as a blank or corrupt frame later rather than failing here.
// Passing NULL removes it. Does not show anything by itself.
void ui_set_idle_image(const uint8_t *jpeg, uint32_t len);

// Covers the talk UI with that picture, and uncovers it again. Safe to call
// when no image has been set - it simply does nothing.
void ui_screensaver(bool on);

// On-device settings, reached by double-pressing the button. Shows what a
// parent needs when something is wrong, and offers the two ways out.
//
// The callbacks fire from an LVGL event, so they must not block - post to the
// app queue or reboot, nothing in between.
typedef struct {
    const char *wifi;        // SSID it is on, or NULL when not connected
    const char *version;     // running firmware
    const char *device_id;   // the same id the dashboard asks you to type
    const char *battery;     // one line, already worded
    void (*on_forget_wifi)(void);
    void (*on_factory_reset)(void);
    void (*on_close)(void);
} ui_settings_t;

void ui_show_settings(const ui_settings_t *s);

// Takes the panel to black and back. The AMOLED has no backlight, so this is
// brightness 0: the pixels stop emitting, which is where nearly all the idle
// power goes. LVGL keeps running, so waking is instant and needs no re-init.
void ui_display_sleep(bool asleep);

ui_state_t ui_get_state(void);

#ifdef __cplusplus
}
#endif
