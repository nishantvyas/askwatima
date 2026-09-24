import { useCallback, useEffect, useState } from "react"
import type { Device, Turn, UsageDay } from "@/lib/api"
import { getHistory, getUsage } from "@/lib/api"
import { browserTz, formatDay, formatTime } from "@/lib/settings"
import { UsageChart } from "@/components/UsageChart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"

const PAGE = 20

export function History({
  devices,
  deviceId,
  onPick,
}: {
  devices: Device[]
  deviceId: string
  onPick: (id: string) => void
}) {
  const [turns, setTurns] = useState<Turn[] | null>(null)
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [usage, setUsage] = useState<UsageDay[] | null>(null)
  const [err, setErr] = useState("")

  const device = devices.find((d) => d.deviceId === deviceId)
  const tz = device?.timezone || browserTz

  useEffect(() => {
    let live = true
    setTurns(null)
    setUsage(null)
    setErr("")
    // A full year, because the chart's month view spans 12 of them and the
    // bucketing happens client-side. Rollup rows are tiny and only exist for
    // days with usage, so this is a few dozen documents at worst.
    // The chart must not be able to take the transcript down with it.
    getUsage(deviceId, 365).then((r) => live && setUsage(r.days)).catch(() => live && setUsage([]))
    getHistory(deviceId, { limit: PAGE })
      .then((r) => {
        if (!live) return
        setTurns(r.turns)
        setMore(r.more)
      })
      .catch((e) => live && setErr((e as Error).message))
    return () => {
      live = false
    }
  }, [deviceId])

  const loadMore = useCallback(async () => {
    if (!turns?.length) return
    setLoadingMore(true)
    try {
      const oldest = turns[turns.length - 1].ts
      const r = await getHistory(deviceId, { limit: PAGE, before: oldest ?? undefined })
      setTurns((cur) => [...(cur || []), ...r.turns])
      setMore(r.more)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoadingMore(false)
    }
  }, [deviceId, turns])

  return (
    <>
      <h2 className="serif mb-2 text-[34px] leading-tight font-medium tracking-[-0.02em]">
        What it heard
      </h2>
      <p className="mb-6 text-[var(--muted-foreground)]">
        Every question asked, and the answer given.
      </p>

      {/* Base UI hands back null when a selection is cleared; there is no
          "no device" state here, so ignore it rather than blanking the view. */}
      {devices.length > 1 && (
        <Select value={deviceId} onValueChange={(v) => v && onPick(v)}>
          <SelectTrigger className="mb-6 w-[280px] max-w-full">
            <SelectValue>
              {(v) => {
                const d = devices.find((x) => x.deviceId === v)
                return d ? d.name || `Watima — ${d.deviceId}` : String(v)
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {devices.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.name || "Watima"} — {d.deviceId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {err && <p className="text-[var(--destructive)]">{err}</p>}

      {usage === null && !err && <Skeleton className="mb-9 h-[230px] w-full rounded-[18px]" />}
      {usage !== null && <UsageChart days={usage} tz={tz} />}

      <TokenNote />

      {!turns && !err && (
        <div className="grid gap-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {turns && turns.length === 0 && (
        <div className="rounded-[18px] border border-dashed border-[var(--line)] px-7 py-11 text-center text-[var(--muted-foreground)]">
          <h3 className="mb-1.5 text-[20px] font-semibold text-[var(--ink)]">Nothing stored</h3>
          <p>
            {device?.memoryMode === "off"
              ? "This device is set never to keep anything, so there is nothing to show."
              : "It hasn't been asked anything yet."}
          </p>
        </div>
      )}

      {turns && turns.length > 0 && (
        <>
          <Timeline turns={turns} tz={tz} />
          {more && (
            <div className="mt-7 flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : `Load ${PAGE} more`}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  )
}

/**
 * Said plainly and once, above the numbers. "Token" is a word parents will have
 * met in an AI context meaning roughly a word, and ours is not that — it also
 * carries the spoken audio, which is most of it. Leaving them to infer the
 * difference from a number that moves faster than they expect is how a billing
 * unit loses trust.
 */
function TokenNote() {
  return (
    <div className="mb-7 rounded-[14px] border border-[var(--line)] bg-[var(--wash)] px-4 py-3 text-[13.5px] leading-relaxed text-[var(--muted-foreground)]">
      <strong className="font-semibold text-[var(--ink)]">About these tokens.</strong> A Watima
      token is not the "roughly a word" token you may have seen elsewhere. Each one covers the
      whole turn: understanding your child's recorded question, working out the answer, and —
      most of the cost — speaking it back out loud. Watima's own running costs are included
      too, so what you see here is the whole of what a question costs. Nothing is added on top.
    </div>
  )
}

/** Grouped by day - a flat list of timestamps is not how anyone reads a week
 *  of their child's questions back. */
function Timeline({ turns, tz }: { turns: Turn[]; tz: string }) {
  let lastDay = ""
  return (
    <div>
      {turns.map((t, i) => {
        const day = t.ts ? formatDay(t.ts, tz) : "Earlier"
        const newDay = day !== lastDay
        lastDay = day
        return (
          <div key={i}>
            {newDay && (
              <div className="mt-8 mb-4 text-[11.5px] font-bold tracking-[0.17em] text-[var(--muted-foreground)] first:mt-0">
                {day.toUpperCase()}
              </div>
            )}
            <div className="ml-[3px] border-l-2 border-[var(--line)] pb-5 pl-[18px]">
              <div className="font-semibold">{t.q}</div>
              <div className="mt-1 text-[var(--body-ink)]">{t.a}</div>
              <div className="mt-1.5 flex items-center gap-2 text-[12px] text-[#9AA4AE]">
                {t.ts && <span>{formatTime(t.ts, tz)}</span>}
                {/* Absent on turns from before metering, and on any turn whose
                    cost never got written back. Showing nothing beats showing a
                    zero that reads as "this one was free". */}
                {t.tokens !== null && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{t.tokens.toLocaleString()} tokens</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
