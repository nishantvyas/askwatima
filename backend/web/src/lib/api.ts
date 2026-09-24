import { auth } from "./firebase"

const API = "https://us-central1-watima-7d274.cloudfunctions.net/talk"

export type Device = {
  deviceId: string
  name: string
  claimedAt: number | null
  memoryMode: MemoryMode
  age: number | null
  timezone: string | null
  tokensSpent: number
}

/** Tokens are the billing unit; one turn costs roughly 700-2,000 of them
 *  depending on the child's age, because answer length is age-banded. */
export type Account = { balance: number; granted: number; spent: number }

export type MemoryMode = "off" | "session" | "persistent"

export type Turn = { q: string; a: string; ts: number | null; tokens: number | null }

/** One row per calendar day, in the device's timezone. */
export type UsageDay = { date: string; questions: number; tokens: number }

/**
 * Every call carries a fresh ID token. Identity is never sent as a plain field -
 * the backend derives the uid from the verified token, so a forged deviceId or
 * uid in the body buys nothing.
 */
async function call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const user = auth.currentUser
  if (!user) throw new Error("Sign in first.")

  const res = await fetch(API + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await user.getIdToken()}`,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body means an infrastructure error rather than ours; the raw
    // text is more useful than "unexpected token < in JSON".
    throw new Error(text.slice(0, 200) || `Request failed (${res.status})`)
  }

  if (!res.ok) {
    const msg = (data as { error?: string })?.error
    throw new Error(msg || `Request failed (${res.status})`)
  }
  return data as T
}

export const listDevices = () => call<{ devices: Device[] }>("/api/devices")

export const getAccount = () => call<Account>("/api/account")

/** `position` starts at a display offset; `count` is real signups. They are
 *  intentionally different numbers — see QUEUE_START in functions/index.js. */
export type Reservation = { position: number | null; reserved: boolean; count: number }

export const getReservation = () => call<Reservation>("/api/reservation")
export const joinReservation = () => call<Reservation>("/api/reservation", { join: true })

/** `before` is the ts of the oldest turn already held — the load-more cursor. */
export const getHistory = (deviceId: string, opts: { limit?: number; before?: number } = {}) =>
  call<{ turns: Turn[]; more: boolean }>("/api/history", { deviceId, ...opts })

export const getUsage = (deviceId: string, days = 90) =>
  call<{ days: UsageDay[] }>("/api/usage", { deviceId, days })

export const clearHistory = (deviceId: string) =>
  call<{ deleted: number }>("/api/history/clear", { deviceId })

export const releaseDevice = (deviceId: string) => call<{ ok: true }>("/api/release", { deviceId })

export const redeemClaim = (code: string) =>
  call<{ ok: true; deviceId: string }>("/claim/redeem", { code })

/** Any subset may be sent; null clears a field. */
export const saveSettings = (
  deviceId: string,
  patch: { memoryMode?: MemoryMode; age?: number | null; timezone?: string | null },
) => call<Device>("/api/settings", { deviceId, ...patch })
