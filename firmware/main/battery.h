#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// 0-100, or -1 when no pack is fitted or the reading is implausible.
// Moves by at most one point per call: voltage is a noisy fuel gauge and a
// number that jitters reads as broken.
// Takes ONE reading and advances the smoothed value by at most a point.
// Drive this from a timer. Never call it to render a screen - see battery.cpp.
void battery_sample(void);

// Current smoothed value, 0-100, or -1 with no pack fitted. Read-only.
int battery_percent(void);

// True while the charger holds GPIO7 low.
bool battery_charging(void);

// Averaged pack voltage in millivolts, 0 if unreadable.
uint32_t battery_millivolts(void);

// One ready-made line: "Battery 76%", "Charging 76%", "Plugged in", "No battery".
// Points at a static buffer - copy it if you need to keep it.
const char *battery_text(void);

#ifdef __cplusplus
}
#endif
