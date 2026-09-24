#include "battery.h"

#include <inttypes.h>
#include <stdio.h>

#include "esp32_s3_touch_amoled_1.43c.h"
#include "esp_log.h"

static const char *TAG = "battery";

/*
 * Voltage only - this board has no fuel gauge.
 *
 * The board's own driver owns ADC1 (a second adc_oneshot_new_unit() here
 * returned "adc1 is already in use"), so everything comes through the BSP.
 * That also settles the divider: the vendor multiplies the pin voltage by two,
 * so the ratio is read from their code rather than assumed.
 *
 * What this cannot be is accurate. A real fuel gauge - a MAX17048 on I2C, say -
 * models the cell and reports true state of charge; voltage alone reads high
 * while charging, low under load, and is nearly flat through the middle of the
 * discharge curve. Treat the number as "roughly", not as a measurement.
 */

// Resting-voltage curve for a single lithium cell. Deliberately coarse at the
// top and bottom where the curve is flat.
static const struct { uint16_t mv; uint8_t pct; } kCurve[] = {
    {4200, 100}, {4100, 90}, {4000, 80}, {3930, 70}, {3870, 60},
    {3820, 50},  {3790, 40}, {3770, 30}, {3740, 20}, {3680, 10},
    {3450, 5},   {3200, 0},
};

// Moves one point per sample. The cell recovers a few millivolts whenever a
// load drops - the display sleeping is enough - and without this the percentage
// visibly jumps around for reasons that have nothing to do with charge.
static int s_smoothed = -1;

uint32_t battery_millivolts(void)
{
    // Averaged: single samples swing by tens of millivolts, and a stable
    // reading is worth more here than an instantaneous one.
    uint32_t total = 0;
    int taken = 0;
    for (int i = 0; i < 8; i++) {
        const uint16_t mv = bsp_batt_get_voltage();
        if (mv == 0) continue;
        total += mv;
        taken++;
    }
    return taken ? total / (uint32_t)taken : 0;
}

/*
 * STAT as this board actually behaves: 1 = external power present, 0 = running
 * on the cell. That is INVERTED from the vendor's comment ("0 = charging"), and
 * both halves are measured - STAT read 1 repeatedly while plugged in and
 * gaining voltage, and a build that treated 0 as charging showed "Charging" on
 * a device sitting unplugged on a desk.
 *
 * An earlier version inferred this from the voltage trend instead, reasoning
 * that only a charger can raise a cell's voltage. True of charge, false of
 * VOLTAGE: when the device sleeps, the display load disappears and the cell
 * recovers several millivolts, which is indistinguishable from charging.
 */
bool battery_charging(void)
{
    return bsp_batt_get_status() != 0;
}

void battery_sample(void)
{
    const uint32_t mv = battery_millivolts();

    // Outside a plausible cell voltage there is no pack fitted, or the reading
    // failed. Report nothing rather than invent a number.
    if (mv < 2500 || mv > 4500) {
        s_smoothed = -1;
        return;
    }

    int pct = 0;
    if (mv >= kCurve[0].mv) {
        pct = 100;
    } else {
        for (size_t i = 1; i < sizeof(kCurve) / sizeof(kCurve[0]); i++) {
            if (mv >= kCurve[i].mv) {
                const int span_mv = kCurve[i - 1].mv - kCurve[i].mv;
                const int span_pct = kCurve[i - 1].pct - kCurve[i].pct;
                pct = kCurve[i].pct + ((int)(mv - kCurve[i].mv) * span_pct) / span_mv;
                break;
            }
        }
    }

    if (s_smoothed < 0) s_smoothed = pct;            // first reading: trust it
    else if (pct > s_smoothed) s_smoothed++;
    else if (pct < s_smoothed) s_smoothed--;

    ESP_LOGI(TAG, "pack %" PRIu32 " mV -> %d%% (shown %d%%), %s",
             mv, pct, s_smoothed, battery_charging() ? "charging" : "on battery");
}

int battery_percent(void)
{
    // Read-only. Seeds itself if nothing has sampled yet, so the first settings
    // screen after boot is not blank.
    if (s_smoothed < 0) battery_sample();
    return s_smoothed;
}

const char *battery_text(void)
{
    static char buf[32];
    const int pct = battery_percent();

    if (pct < 0) {
        return battery_charging() ? "Plugged in" : "No battery";
    }
    snprintf(buf, sizeof(buf), "%s %d%%", battery_charging() ? "Charging" : "Battery", pct);
    return buf;
}
