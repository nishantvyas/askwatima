import { useCallback, useEffect, useState } from "react"
import { getReservation, joinReservation, type Reservation } from "@/lib/api"
import { Button } from "@/components/ui/button"

/**
 * Shown under the pairing screen to a signed-in parent who has no device yet.
 * The account already exists by the time this renders — signing in with Google
 * created it — so reserving is one button and no form.
 *
 * Only `position` is shown. The API also returns `count` (real signups), but
 * nothing renders it — which sidesteps the trap entirely: `position` starts at
 * an offset and is just a reservation ID nobody can check, whereas any visible
 * headcount would be a factual claim about other people. If a count is ever
 * added back, use `res.count` and never derive it from the offset. See
 * QUEUE_START in functions/index.js.
 */
export function Reserve() {
  const [res, setRes] = useState<Reservation | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  useEffect(() => {
    let live = true
    // The marketing page's button is itself the reserve action, so arriving
    // with ?reserve=1 means the parent already decided — making them click a
    // second button here would read as the first one not having worked.
    // joinQueue is idempotent on uid, so a reload of this URL is harmless.
    const wants = new URLSearchParams(window.location.search).get("reserve") === "1"
    const first = wants ? joinReservation() : getReservation()
    first
      .then((r) => {
        if (!live) return
        setRes(r)
        if (wants) {
          // Drop the param so a refresh isn't a second join attempt and the
          // URL stops describing an action that already happened.
          const u = new URL(window.location.href)
          u.searchParams.delete("reserve")
          window.history.replaceState({}, "", u.toString())
        }
      })
      .catch(() => live && setRes(null))
    return () => {
      live = false
    }
  }, [])

  const join = useCallback(async () => {
    setBusy(true)
    setErr("")
    try {
      setRes(await joinReservation())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  if (!res) return null

  if (res.reserved) {
    return (
      <section className="mb-10 rounded-[18px] border border-[#BFE5D5] bg-[#EAF7F1] p-6">
        <p className="text-[13px] font-semibold tracking-[0.14em] text-[var(--listen-ink)]">
          YOU'RE IN THE QUEUE
        </p>
        <p className="serif mt-1 text-[38px] leading-none font-medium tracking-[-0.02em]">
          #{res.position}
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-[var(--body-ink)]">
          That's your place in line. Nothing has been charged. I build and ship in batches of
          ten, so the queue moves in steps — I'll email you if the timeline moves, when I set
          the final price, and before your batch ships.
        </p>
      </section>
    )
  }

  return (
    <section className="mb-10 rounded-[18px] border border-[var(--line)] p-6">
      <p className="text-[13px] font-semibold tracking-[0.14em] text-[var(--muted-foreground)]">
        NO DEVICE YET?
      </p>
      <h3 className="serif mt-1 text-[24px] leading-tight font-medium tracking-[-0.02em]">
        Reserve one from the first run.
      </h3>
      <p className="mt-2 mb-5 text-[15px] leading-relaxed text-[var(--body-ink)]">
        $69.99 instead of $99.99 for the first 1,000 — the device plus a million tokens, and
        no subscription. Nothing is charged now, and you can leave the queue any time.
      </p>
      {err && <p className="mb-3 text-[15px] text-[var(--destructive)]">{err}</p>}
      <Button onClick={join} disabled={busy}>
        {busy ? "Reserving…" : "Reserve my place"}
      </Button>
    </section>
  )
}
