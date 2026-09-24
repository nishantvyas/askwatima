import type { MemoryMode } from "./api"

/**
 * These mirror constants in functions/index.js. They are duplicated rather than
 * fetched because the backend is the authority on behaviour and this copy only
 * describes it to a parent - a drift shows up as wrong prose, never as a device
 * that behaves differently from what was saved.
 */

export const MEMORY: Record<MemoryMode, { label: string; says: string }> = {
  // Named for what the child experiences. The second clause is not padding:
  // "off" also empties History, and a parent choosing the most private option
  // should learn that here rather than by finding an empty History tab and
  // assuming it is broken.
  off: {
    label: "Never",
    says: "Every question stands alone. Nothing is kept, so History stays empty.",
  },
  session: {
    label: "For an hour",
    says: "Follow-up questions work for an hour. Kept for a day.",
  },
  persistent: {
    label: "Always",
    says: "Follow-up questions always work. Kept for thirty days.",
  },
}

export const AGE_MIN = 5
export const AGE_MAX = 11

/** Word bands by age. A range, not a target - a single number makes it pad. */
export const AGE_WORDS: Record<number, [number, number]> = {
  5: [25, 30],
  6: [35, 40],
  7: [55, 60],
  8: [75, 80],
  9: [90, 100],
  10: [100, 110],
  11: [100, 125],
}

export const AGES = Object.keys(AGE_WORDS).map(Number)

export function ageWhy(age: number | null): string {
  if (!age) {
    return "Short answers, around twenty-five to thirty words. Set an age and Watima matches both the words it chooses and how long it talks."
  }
  const [lo, hi] = AGE_WORDS[Math.max(AGE_MIN, Math.min(AGE_MAX, age))]
  return `About ${lo} to ${hi} words — ${hi <= 40 ? "a sentence or two" : "a few sentences"}.`
}

export const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

/** Every zone ICU knows, rather than a shortlist that is wrong for somebody. */
export const TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [browserTz]

/** Current wall clock in a zone, so the choice is concrete before saving it. */
export function nowIn(tz: string): string {
  try {
    return (
      "Currently " +
      new Date().toLocaleTimeString([], { timeZone: tz, hour: "numeric", minute: "2-digit" })
    )
  } catch {
    return ""
  }
}

/**
 * Stored timestamps are absolute instants; the zone decides which day and clock
 * time they land on. Without it a late-evening question can appear under the
 * next morning for a parent reading from another country.
 */
export function formatDay(ts: number, tz: string): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  })
}

export function formatTime(ts: number, tz: string): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  })
}
