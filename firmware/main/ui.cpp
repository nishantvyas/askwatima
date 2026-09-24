#include "ui.h"
#include "app_config.h"

#include <string.h>
#include "lvgl.h"
#include "esp_log.h"
#include "esp32_s3_touch_amoled_1.43c.h"

static const char *TAG = "ui";

// The panel is a 466x466 circle. Everything lives inside a ~340px square so it
// stays clear of the rounded edge.
#define RING_SIZE      200
#define RING_Y        (-18)
#define CONTENT_W      340

static const lv_color_t kBlack = LV_COLOR_MAKE(0x00, 0x00, 0x00);

typedef struct {
    uint32_t color;
    uint32_t dot;       // resting dot diameter
    uint32_t dot_peak;  // pulse target
    uint32_t period;    // ms for one pulse leg
    const char *title;
    const char *hint;
} state_style_t;

static const state_style_t kStyles[] = {
    [UI_IDLE]      = {0x5A626E, 46,  52, 1400, "HOLD TO TALK", "press and hold"},
    [UI_LISTENING] = {0x34E0A1, 54,  70,  520, "LISTENING",    "release to send"},
    [UI_THINKING]  = {0xF2A93B, 62,  74,  760, "THINKING",     ""},
    [UI_COMPOSING] = {0x9B7BF0, 78,  90,  620, "ALMOST THERE", ""},
    [UI_SPEAKING]  = {0x4C7DF0, 118, 128, 900, "SPEAKING",     "press to stop"},
    [UI_ERROR]     = {0xFF5C5C, 50,  50, 1000, "OFFLINE",      "check wifi / backend"},
};

static lv_obj_t *s_ring;
static lv_obj_t *s_dot;
static lv_obj_t *s_arc;
static lv_obj_t *s_title;
static lv_obj_t *s_hint;
#if UI_SHOW_ANSWER_TEXT
static lv_obj_t *s_answer;
#endif
static ui_state_t s_state = UI_IDLE;

static void dot_size_cb(void *obj, int32_t v)
{
    lv_obj_set_size((lv_obj_t *)obj, v, v);
    lv_obj_center((lv_obj_t *)obj);
}

static void ring_opa_cb(void *obj, int32_t v)
{
    lv_obj_set_style_border_opa((lv_obj_t *)obj, (lv_opa_t)v, 0);
}

static void arc_value_cb(void *obj, int32_t v)
{
    lv_arc_set_value((lv_obj_t *)obj, v);
}

void ui_create(void)
{
    lv_obj_t *scr = lv_screen_active();
    lv_obj_remove_style_all(scr);
    lv_obj_set_style_bg_color(scr, kBlack, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

#if UI_SHOW_ANSWER_TEXT
    // Reply text, sits above the ring while speaking.
    s_answer = lv_label_create(scr);
    lv_label_set_long_mode(s_answer, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_answer, CONTENT_W);
    lv_obj_set_style_text_align(s_answer, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_font(s_answer, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(s_answer, lv_color_hex(0x9FC0FF), 0);
    lv_obj_align(s_answer, LV_ALIGN_CENTER, 0, -152);
    lv_label_set_text(s_answer, "");
    lv_obj_add_flag(s_answer, LV_OBJ_FLAG_HIDDEN);
#endif

    // Outline ring.
    s_ring = lv_obj_create(scr);
    lv_obj_remove_style_all(s_ring);
    lv_obj_set_size(s_ring, RING_SIZE, RING_SIZE);
    lv_obj_align(s_ring, LV_ALIGN_CENTER, 0, RING_Y);
    lv_obj_set_style_radius(s_ring, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(s_ring, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(s_ring, 4, 0);
    lv_obj_remove_flag(s_ring, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(s_ring, LV_OBJ_FLAG_CLICKABLE);

    // Progress arc, just outside the ring. Hidden except while working.
    s_arc = lv_arc_create(scr);
    lv_obj_set_size(s_arc, RING_SIZE + 34, RING_SIZE + 34);
    lv_obj_align(s_arc, LV_ALIGN_CENTER, 0, RING_Y);
    lv_arc_set_rotation(s_arc, 270);          // start at 12 o'clock
    lv_arc_set_bg_angles(s_arc, 0, 360);
    lv_arc_set_range(s_arc, 0, 1000);         // 0.1% steps keep the crawl smooth
    lv_arc_set_value(s_arc, 0);
    lv_obj_remove_style(s_arc, NULL, LV_PART_KNOB);
    lv_obj_remove_flag(s_arc, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_arc_width(s_arc, 3, LV_PART_MAIN);
    lv_obj_set_style_arc_width(s_arc, 3, LV_PART_INDICATOR);
    lv_obj_set_style_arc_opa(s_arc, LV_OPA_20, LV_PART_MAIN);
    lv_obj_add_flag(s_arc, LV_OBJ_FLAG_HIDDEN);

    // Filled centre dot.
    s_dot = lv_obj_create(s_ring);
    lv_obj_remove_style_all(s_dot);
    lv_obj_set_style_radius(s_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(s_dot, LV_OPA_COVER, 0);
    lv_obj_remove_flag(s_dot, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(s_dot, LV_OBJ_FLAG_CLICKABLE);

    s_title = lv_label_create(scr);
    lv_obj_set_style_text_font(s_title, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_letter_space(s_title, 3, 0);
    lv_obj_align(s_title, LV_ALIGN_CENTER, 0, 122);

    // Same readability bump as the setup and pairing screens - "release to
    // send" is an instruction, and at 16pt on this panel it was not legible at
    // arm's length.
    s_hint = lv_label_create(scr);
    lv_obj_set_style_text_font(s_hint, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(s_hint, lv_color_hex(0x9AA0AA), 0);
    lv_obj_align(s_hint, LV_ALIGN_CENTER, 0, 164);

    s_state = UI_IDLE;
    const state_style_t *st = &kStyles[UI_IDLE];
    lv_obj_set_style_border_color(s_ring, lv_color_hex(st->color), 0);
    lv_obj_set_style_bg_color(s_dot, lv_color_hex(st->color), 0);
    lv_obj_set_size(s_dot, st->dot, st->dot);
    lv_obj_center(s_dot);
    lv_obj_set_style_text_color(s_title, lv_color_hex(st->color), 0);
    lv_label_set_text(s_title, st->title);
    lv_label_set_text(s_hint, st->hint);

    ESP_LOGI(TAG, "ui ready");
}

// Assumes the display lock is held.
static void apply_state(ui_state_t s)
{
    // Between ui_reset_screen() and ui_create() every widget pointer is NULL.
    // The app task does not know that, so bail rather than dereference.
    if (!s_ring || !s_dot || !s_title || !s_hint || !s_arc) return;

    const state_style_t *st = &kStyles[s];
    lv_color_t c = lv_color_hex(st->color);

    lv_anim_delete(s_dot, dot_size_cb);
    lv_anim_delete(s_ring, ring_opa_cb);

    lv_obj_set_style_border_color(s_ring, c, 0);
    lv_obj_set_style_border_opa(s_ring, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s_dot, c, 0);
    lv_obj_set_size(s_dot, st->dot, st->dot);
    lv_obj_center(s_dot);

    lv_obj_set_style_text_color(s_title, c, 0);
    lv_label_set_text(s_title, st->title);
    lv_label_set_text(s_hint, st->hint);

    // The arc belongs to the working states only.
    const bool working = (s == UI_THINKING || s == UI_COMPOSING);
    lv_obj_set_style_arc_color(s_arc, c, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(s_arc, c, LV_PART_MAIN);
    if (working) {
        lv_obj_remove_flag(s_arc, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_anim_delete(s_arc, arc_value_cb);
        lv_arc_set_value(s_arc, 0);
        lv_obj_add_flag(s_arc, LV_OBJ_FLAG_HIDDEN);
    }

#if UI_SHOW_ANSWER_TEXT
    if (s == UI_SPEAKING) {
        lv_obj_remove_flag(s_answer, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(s_answer, LV_OBJ_FLAG_HIDDEN);
    }
#endif

    // Breathing pulse everywhere except the two resting states.
    if (st->dot_peak != st->dot) {
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, s_dot);
        lv_anim_set_exec_cb(&a, dot_size_cb);
        lv_anim_set_values(&a, st->dot, st->dot_peak);
        lv_anim_set_duration(&a, st->period);
        lv_anim_set_playback_duration(&a, st->period);
        lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
        lv_anim_start(&a);
    }
    if (s == UI_THINKING || s == UI_LISTENING) {
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, s_ring);
        lv_anim_set_exec_cb(&a, ring_opa_cb);
        lv_anim_set_values(&a, LV_OPA_40, LV_OPA_COVER);
        lv_anim_set_duration(&a, st->period);
        lv_anim_set_playback_duration(&a, st->period);
        lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
        lv_anim_start(&a);
    }
}

void ui_set_state(ui_state_t s)
{
    if (bsp_display_lock(-1) != ESP_OK) return;
    s_state = s;
    apply_state(s);
    bsp_display_unlock();
}

void ui_set_answer(const char *text)
{
#if UI_SHOW_ANSWER_TEXT
    if (bsp_display_lock(-1) != ESP_OK) return;
    lv_label_set_text(s_answer, text ? text : "");
    bsp_display_unlock();
#else
    (void)text;   // voice-only: the reply is spoken, never drawn
#endif
}

void ui_set_hint(const char *text)
{
    if (!s_hint) return;
    if (bsp_display_lock(-1) != ESP_OK) return;
    if (!s_hint) { bsp_display_unlock(); return; }   // reset while we waited
    lv_label_set_text(s_hint, text ? text : "");
    bsp_display_unlock();
}

void ui_show_setup(const char *ap_ssid)
{
    if (bsp_display_lock(-1) != ESP_OK) return;

    lv_obj_t *scr = lv_screen_active();
    ui_reset_screen();
    scr = lv_screen_active();   // drop the talk UI entirely; we are not coming back
    lv_obj_set_style_bg_color(scr, kBlack, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    lv_obj_t *title = lv_label_create(scr);
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_letter_space(title, 2, 0);
    lv_obj_set_style_text_color(title, lv_color_hex(0x4C7DF0), 0);
    lv_label_set_text(title, "SETUP");
    lv_obj_align(title, LV_ALIGN_CENTER, 0, -168);

    // Standard Wi-Fi join payload - a phone camera reads this and offers to
    // connect, so nobody has to type the network name.
    char payload[96];
    snprintf(payload, sizeof(payload), "WIFI:S:%s;T:nopass;;", ap_ssid);

    lv_obj_t *qr = lv_qrcode_create(scr);
    lv_qrcode_set_size(qr, 190);
    lv_qrcode_set_dark_color(qr, lv_color_hex(0x000000));
    lv_qrcode_set_light_color(qr, lv_color_hex(0xFFFFFF));
    lv_qrcode_update(qr, payload, strlen(payload));
    lv_obj_align(qr, LV_ALIGN_CENTER, 0, -22);
    lv_obj_set_style_border_width(qr, 6, 0);          // quiet zone
    lv_obj_set_style_border_color(qr, lv_color_hex(0xFFFFFF), 0);

    lv_obj_t *name = lv_label_create(scr);
    lv_obj_set_style_text_font(name, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(name, lv_color_hex(0xEDEDED), 0);
    lv_label_set_text(name, ap_ssid);
    lv_obj_align(name, LV_ALIGN_CENTER, 0, 110);

    lv_obj_t *hint = lv_label_create(scr);
    lv_obj_set_style_text_font(hint, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(hint, lv_color_hex(0x9AA0AA), 0);
    lv_label_set_long_mode(hint, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(hint, 340);
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint, "scan, or join this wifi\nthen open 192.168.4.1");
    lv_obj_align(hint, LV_ALIGN_CENTER, 0, 150);

    bsp_display_unlock();
    ESP_LOGI(TAG, "setup screen up for \"%s\"", ap_ssid);
}

void ui_show_claim(const char *code)
{
    if (bsp_display_lock(-1) != ESP_OK) return;

    lv_obj_t *scr = lv_screen_active();
    ui_reset_screen();
    scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, kBlack, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    // Sized to be read at arm's length off a 1.43" panel, not to look balanced
    // in a screenshot. Supporting text at 24pt and a lighter grey that still
    // clears the background.
    lv_obj_t *top = lv_label_create(scr);
    lv_obj_set_style_text_font(top, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(top, lv_color_hex(0xC8CDD4), 0);
    lv_obj_set_style_text_align(top, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(top, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(top, 340);
    lv_label_set_text(top, "enter this code\nin the Watima app");
    lv_obj_align(top, LV_ALIGN_CENTER, 0, -115);

    // Spaced into two groups of three - noticeably easier to read off a small
    // round screen and retype without losing your place.
    char spaced[16];
    snprintf(spaced, sizeof(spaced), "%.3s %.3s", code, code + 3);

    // The code goes up too, so it stays clearly dominant now the supporting
    // text is larger.
    lv_obj_t *big = lv_label_create(scr);
    lv_obj_set_style_text_font(big, &lv_font_montserrat_36, 0);
    lv_obj_set_style_text_letter_space(big, 5, 0);
    lv_obj_set_style_text_color(big, lv_color_hex(0x34E0A1), 0);
    lv_label_set_text(big, spaced);
    lv_obj_align(big, LV_ALIGN_CENTER, 0, -20);

    lv_obj_t *hint = lv_label_create(scr);
    lv_obj_set_style_text_font(hint, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(hint, lv_color_hex(0x9AA0AA), 0);
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(hint, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(hint, 360);
    lv_label_set_text(hint, "waiting to be paired");
    lv_obj_align(hint, LV_ALIGN_CENTER, 0, 92);

    // Second line kept smaller and dimmer - it is reassurance, not instruction,
    // and at 20pt it competed with the actual message.
    lv_obj_t *sub = lv_label_create(scr);
    lv_obj_set_style_text_font(sub, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(sub, lv_color_hex(0x6B7280), 0);
    lv_obj_set_style_text_align(sub, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(sub, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(sub, 320);
    lv_label_set_text(sub, "code changes every 10 minutes");
    lv_obj_align(sub, LV_ALIGN_CENTER, 0, 130);

    bsp_display_unlock();
    ESP_LOGI(TAG, "claim screen up");
}

static lv_obj_t *s_upd_bar;
static lv_obj_t *s_upd_pct;

void ui_show_updating(const char *version)
{
    if (bsp_display_lock(-1) != ESP_OK) return;

    lv_obj_t *scr = lv_screen_active();
    ui_reset_screen();
    scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, kBlack, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    lv_obj_t *title = lv_label_create(scr);
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_letter_space(title, 2, 0);
    lv_obj_set_style_text_color(title, lv_color_hex(0x4C7DF0), 0);
    lv_label_set_text(title, "UPDATING");
    lv_obj_align(title, LV_ALIGN_CENTER, 0, -60);

    s_upd_bar = lv_bar_create(scr);
    lv_obj_set_size(s_upd_bar, 240, 8);
    lv_obj_align(s_upd_bar, LV_ALIGN_CENTER, 0, 0);
    lv_bar_set_range(s_upd_bar, 0, 100);
    lv_bar_set_value(s_upd_bar, 0, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(s_upd_bar, lv_color_hex(0x22262E), LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_upd_bar, lv_color_hex(0x4C7DF0), LV_PART_INDICATOR);
    lv_obj_set_style_radius(s_upd_bar, 4, LV_PART_MAIN);
    lv_obj_set_style_radius(s_upd_bar, 4, LV_PART_INDICATOR);

    s_upd_pct = lv_label_create(scr);
    lv_obj_set_style_text_font(s_upd_pct, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(s_upd_pct, lv_color_hex(0xEDEDED), 0);
    lv_label_set_text(s_upd_pct, "0%");
    lv_obj_align(s_upd_pct, LV_ALIGN_CENTER, 0, 32);

    lv_obj_t *hint = lv_label_create(scr);
    lv_obj_set_style_text_font(hint, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(hint, lv_color_hex(0x9AA0AA), 0);
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(hint, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(hint, 300);
    lv_label_set_text(hint, "keep me plugged in\ndo not unplug");
    lv_obj_align(hint, LV_ALIGN_CENTER, 0, 80);

    (void)version;
    bsp_display_unlock();
}

void ui_set_update_progress(int pct)
{
    if (!s_upd_bar) return;
    if (bsp_display_lock(200) != ESP_OK) return;   // never block the download
    lv_bar_set_value(s_upd_bar, pct, LV_ANIM_OFF);
    char t[8];
    snprintf(t, sizeof(t), "%d%%", pct);
    lv_label_set_text(s_upd_pct, t);
    bsp_display_unlock();
}

void ui_progress_to(int pct, uint32_t ms)
{
    if (!s_arc) return;
    if (bsp_display_lock(-1) != ESP_OK) return;
    if (!s_arc) { bsp_display_unlock(); return; }
    int32_t from = lv_arc_get_value(s_arc);
    int32_t to = pct * 10;                 // range is 0..1000
    if (to > from) {
        lv_anim_delete(s_arc, arc_value_cb);
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, s_arc);
        lv_anim_set_exec_cb(&a, arc_value_cb);
        lv_anim_set_values(&a, from, to);
        lv_anim_set_duration(&a, ms);
        lv_anim_start(&a);
    }
    bsp_display_unlock();
}

ui_state_t ui_get_state(void) { return s_state; }

// Forward declaration: the screensaver pointer lives further down but has to be
// cleared here along with everything else.
static void forget_screensaver(void);

void ui_reset_screen(void)
{
    lv_obj_clean(lv_screen_active());

    // Every cached pointer, without exception. One missed entry is a panic that
    // surfaces somewhere unrelated - this cost a crash loop once already.
    s_ring = NULL;
    s_dot = NULL;
    s_arc = NULL;
    s_title = NULL;
    s_hint = NULL;
#if UI_SHOW_ANSWER_TEXT
    s_answer = NULL;
#endif
    s_upd_bar = NULL;
    s_upd_pct = NULL;
    forget_screensaver();
}

// --- settings ------------------------------------------------------------
// Removing touch-to-talk freed the panel for actual UI. Tapping a large button
// is not the problem the touchscreen has - typing on it is - so the two
// destructive actions are big targets with a confirm step, and nothing here
// ever asks anyone to enter text.

static void settings_row_font(lv_obj_t *parent, const char *text, lv_color_t colour,
                              const lv_font_t *font)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_label_set_text(l, text ? text : "-");
    lv_label_set_long_mode(l, LV_LABEL_LONG_DOT);
    lv_obj_set_width(l, CONTENT_W);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, colour, 0);
}

static void settings_row(lv_obj_t *parent, const char *text, lv_color_t colour)
{
    settings_row_font(parent, text, colour, &lv_font_montserrat_16);
}

static lv_obj_t *settings_button(lv_obj_t *parent, const char *label,
                                 lv_color_t colour, lv_event_cb_t cb, void *arg)
{
    lv_obj_t *b = lv_button_create(parent);
    lv_obj_set_size(b, 300, 62);
    lv_obj_set_style_radius(b, 31, 0);
    lv_obj_set_style_bg_color(b, colour, 0);
    lv_obj_add_event_cb(b, cb, LV_EVENT_CLICKED, arg);

    lv_obj_t *t = lv_label_create(b);
    lv_label_set_text(t, label);
    lv_obj_set_style_text_font(t, &lv_font_montserrat_20, 0);
    lv_obj_center(t);
    return b;
}

// Two taps, never one. A child WILL find this screen, and both of these throw
// away something that cannot be recovered from the device.
static const ui_settings_t *s_pending;
static void (*s_pending_action)(void);

static void confirm_yes_cb(lv_event_t *e)
{
    (void)e;
    if (s_pending_action) s_pending_action();
}

static void confirm_no_cb(lv_event_t *e)
{
    (void)e;
    if (s_pending && s_pending->on_close) s_pending->on_close();
}

// Every one of these runs from lv_async_call, never straight out of a click.
// Rebuilding the screen inside an event handler frees the widget that is
// currently dispatching it, and LVGL walks back into that object afterwards.
static const char *s_confirm_question;

static void build_confirm(void *unused)
{
    (void)unused;
    const char *question = s_confirm_question;

    ui_reset_screen();
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, kBlack, 0);

    lv_obj_t *col = lv_obj_create(scr);
    lv_obj_remove_style_all(col);
    lv_obj_set_size(col, LV_PCT(100), LV_PCT(100));
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(col, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(col, 16, 0);
    lv_obj_remove_flag(col, LV_OBJ_FLAG_SCROLLABLE);

    settings_row(col, question, lv_color_hex(0xFFFFFF));
    settings_button(col, "Yes, do it", lv_color_hex(0xC4402F), confirm_yes_cb, NULL);
    settings_button(col, "Cancel", lv_color_hex(0x2A2E36), confirm_no_cb, NULL);
}

static void ask_confirm(const char *question, void (*action)(void))
{
    s_confirm_question = question;
    s_pending_action = action;
    lv_async_call(build_confirm, NULL);
}

static void forget_wifi_cb(lv_event_t *e)
{
    const ui_settings_t *s = (const ui_settings_t *)lv_event_get_user_data(e);
    ask_confirm("Forget wi-fi?", s->on_forget_wifi);
}

static void factory_reset_cb(lv_event_t *e)
{
    const ui_settings_t *s = (const ui_settings_t *)lv_event_get_user_data(e);
    ask_confirm("Erase everything?", s->on_factory_reset);
}

static void close_cb(lv_event_t *e)
{
    const ui_settings_t *s = (const ui_settings_t *)lv_event_get_user_data(e);
    if (s->on_close) s->on_close();
}

void ui_show_settings(const ui_settings_t *s)
{
    if (!s) return;
    if (bsp_display_lock(-1) != ESP_OK) return;

    s_pending = s;

    lv_obj_t *scr = lv_screen_active();
    ui_reset_screen();
    scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, kBlack, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    lv_obj_t *col = lv_obj_create(scr);
    lv_obj_remove_style_all(col);
    lv_obj_set_size(col, LV_PCT(100), LV_PCT(100));
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(col, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(col, 9, 0);
    lv_obj_remove_flag(col, LV_OBJ_FLAG_SCROLLABLE);

    // What a parent came here to check goes at the top and is readable at
    // arm's length. The identifiers matter only when something is wrong, and
    // reading a twelve-character id off a 1.43" disc is a deliberate act - so
    // they sit under the buttons, quiet and small.
    char line[80];
    snprintf(line, sizeof(line), "Wi-Fi: %s", s->wifi ? s->wifi : "not connected");
    settings_row_font(col, line, lv_color_hex(0x8A939D), &lv_font_montserrat_20);

    settings_row_font(col, s->battery, lv_color_hex(0xC8CDD4), &lv_font_montserrat_24);

    settings_button(col, "Forget wi-fi", lv_color_hex(0x2A2E36), forget_wifi_cb, (void *)s);
    settings_button(col, "Erase everything", lv_color_hex(0x6B2318), factory_reset_cb, (void *)s);
    settings_button(col, "Back", lv_color_hex(0x2A2E36), close_cb, (void *)s);

    settings_row(col, s->device_id, lv_color_hex(0x5C6570));
    settings_row(col, s->version, lv_color_hex(0x5C6570));

    bsp_display_unlock();
    ESP_LOGI(TAG, "settings shown");
}

// --- screensaver ---------------------------------------------------------
// A full-screen image laid over the talk UI rather than a separate screen, so
// nothing has to be torn down and rebuilt on every wake - the ring and its
// animations survive underneath and reappear untouched.

static lv_obj_t *s_saver;
static lv_image_dsc_t s_saver_dsc;

// Called by ui_reset_screen() after the object has already been freed as a
// child of the screen - drop the pointer, do not delete it twice.
static void forget_screensaver(void) { s_saver = NULL; }

/**
 * Reads the pixel dimensions out of a JPEG's SOF segment.
 *
 * This is not optional detail. LVGL's TJPGD decoder does NOT measure the image
 * for you when the source is a memory buffer - decoder_info() copies width and
 * height straight back out of the descriptor it was handed. Leave them zero and
 * the decode "succeeds" while drawing a zero-by-zero image, which on a black UI
 * is indistinguishable from the screen having gone dark.
 *
 * Parsing them here rather than hardcoding 466x466 means a parent's upload of
 * any size still displays, instead of failing in a way nobody can diagnose.
 */
static bool jpeg_size(const uint8_t *d, uint32_t n, uint16_t *w, uint16_t *h)
{
    if (!d || n < 4 || d[0] != 0xFF || d[1] != 0xD8) return false;   // no SOI

    for (uint32_t i = 2; i + 9 < n;) {
        if (d[i] != 0xFF) { i++; continue; }
        const uint8_t m = d[i + 1];
        if (m == 0xFF) { i++; continue; }                            // fill byte
        if (m == 0x01 || (m >= 0xD0 && m <= 0xD9)) { i += 2; continue; }  // no payload

        const uint16_t seg = (uint16_t)((d[i + 2] << 8) | d[i + 3]);

        // SOF0..SOF15 carry the frame header. C4/C8/CC share the range but are
        // Huffman tables, JPEG extensions and arithmetic coding conditioning.
        if (m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC) {
            *h = (uint16_t)((d[i + 5] << 8) | d[i + 6]);
            *w = (uint16_t)((d[i + 7] << 8) | d[i + 8]);
            return *w != 0 && *h != 0;
        }

        if (seg < 2) return false;                                   // malformed
        i += 2u + seg;
    }
    return false;
}

void ui_set_idle_image(const uint8_t *jpeg, uint32_t len)
{
    if (bsp_display_lock(-1) != ESP_OK) return;

    if (!jpeg || len == 0) {
        if (s_saver) {
            lv_obj_delete(s_saver);
            s_saver = NULL;
        }
        bsp_display_unlock();
        return;
    }

    if (!s_saver) {
        s_saver = lv_image_create(lv_screen_active());
        // Sized from the display rather than a panel constant, so this does not
        // silently misplace itself if the hardware ever changes.
        lv_obj_set_size(s_saver, LV_PCT(100), LV_PCT(100));
        lv_obj_align(s_saver, LV_ALIGN_CENTER, 0, 0);
        lv_obj_add_flag(s_saver, LV_OBJ_FLAG_HIDDEN);
    }

    uint16_t w = 0, h = 0;
    if (!jpeg_size(jpeg, len, &w, &h)) {
        ESP_LOGE(TAG, "not a JPEG we can read (%u bytes) - leaving the screen alone",
                 (unsigned)len);
        bsp_display_unlock();
        return;
    }

    // LV_COLOR_FORMAT_RAW hands the bytes to a decoder rather than treating them
    // as pixels. The dimensions must be filled in here - see jpeg_size().
    s_saver_dsc.header.magic = LV_IMAGE_HEADER_MAGIC;
    s_saver_dsc.header.cf = LV_COLOR_FORMAT_RAW;
    s_saver_dsc.header.w = w;
    s_saver_dsc.header.h = h;
    s_saver_dsc.data = jpeg;
    s_saver_dsc.data_size = len;

    lv_image_set_src(s_saver, &s_saver_dsc);
    bsp_display_unlock();
    ESP_LOGI(TAG, "screensaver image set: %ux%u, %u bytes", w, h, (unsigned)len);
}

void ui_screensaver(bool on)
{
    if (!s_saver) return;
    if (bsp_display_lock(-1) != ESP_OK) return;

    if (on) {
        lv_obj_remove_flag(s_saver, LV_OBJ_FLAG_HIDDEN);
        lv_obj_move_foreground(s_saver);

        // Stop the idle breathing FIRST. It is completely hidden behind the
        // image, but an animation still invalidates the screen every frame, and
        // every invalidation redraws the picture on top of it. That is real work
        // - decoding included - done purely so nobody can see it.
        if (s_dot) lv_anim_delete(s_dot, dot_size_cb);
        if (s_ring) lv_anim_delete(s_ring, ring_opa_cb);
    } else {
        lv_obj_add_flag(s_saver, LV_OBJ_FLAG_HIDDEN);
        apply_state(s_state);   // puts the breathing back
    }

    bsp_display_unlock();
}

void ui_display_sleep(bool asleep)
{
    // Brightness zero stops the panel emitting; it does NOT stop LVGL drawing.
    // Hide the picture as well, so an asleep device is genuinely idle rather
    // than quietly rendering a full-screen image nobody can see.
    if (asleep && s_saver && bsp_display_lock(-1) == ESP_OK) {
        lv_obj_add_flag(s_saver, LV_OBJ_FLAG_HIDDEN);
        bsp_display_unlock();
    }
    bsp_display_brightness_set(asleep ? 0 : UI_BRIGHTNESS_PCT);
}
