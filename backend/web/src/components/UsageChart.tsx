import { useMemo, useState } from "react"
import type { UsageDay } from "@/lib/api"

type Bucket = "day" | "week" | "month"
type Metric = "questions" | "tokens"

/**
 * Questions and tokens are two measures on wildly different scales (one is
 * single digits, the other is thousands), so they get a TOGGLE and share one
 * axis rather than being drawn together against two. A dual-axis chart would
 * let us imply any correlation we liked by choosing the scales.
 *
 * Single series throughout, so there is no legend: the heading names what the
 * bars are. Values are labelled on hover and the whole series is also exposed
 * as a table for screen readers, so nothing here is carried by colour alone.
 */
export function UsageChart({ days, tz }: { days: UsageDay[]; tz: string }) {
  const [bucket, setBucket] = useState<Bucket>("day")
  const [metric, setMetric] = useState<Metric>("questions")

  const bars = useMemo(() => group(days, bucket, tz), [days, bucket, tz])
  const max = Math.max(1, ...bars.map((b) => b[metric]))
  const total = bars.reduce((n, b) => n + b[metric], 0)

  // Points on a 0-100 grid, y inverted because SVG counts down from the top.
  const pts = useMemo(
    () =>
      bars.map((b, i) => ({
        x: bars.length > 1 ? (i / (bars.length - 1)) * 100 : 50,
        y: 100 - (b[metric] / max) * 100,
      })),
    [bars, metric, max],
  )
  const line = useMemo(
    () => pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" "),
    [pts],
  )

  if (!days.length) {
    return (
      <div className="mb-8 rounded-[18px] border border-dashed border-[var(--line)] px-7 py-9 text-center text-[var(--muted-foreground)]">
        Nothing asked yet — the chart fills in as your child uses it.
      </div>
    )
  }

  return (
    <section className="mb-9 rounded-[18px] border border-[var(--line)] p-5" aria-label="Usage over time">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-[17px] font-semibold">
            {metric === "questions" ? "Questions asked" : "Tokens used"}
          </h3>
          <p className="mt-0.5 text-[13.5px] text-[var(--muted-foreground)]">
            {total.toLocaleString()} in the last{" "}
            {bucket === "day" ? "30 days" : bucket === "week" ? "12 weeks" : "12 months"}
          </p>
        </div>
        {/* flex-wrap: the two segmented controls measure ~295px side by side,
            against a ~280px card interior at 360px. Without this they push the
            Day/Week/Month group off the edge of the card on a phone. */}
        <div className="flex flex-wrap gap-1.5">
          <Toggle value={metric} onChange={setMetric} options={[
            { k: "questions", label: "Questions" },
            { k: "tokens", label: "Tokens" },
          ]} />
          <Toggle value={bucket} onChange={setBucket} options={[
            { k: "day", label: "Day" },
            { k: "week", label: "Week" },
            { k: "month", label: "Month" },
          ]} />
        </div>
      </div>

      {/* The line itself is SVG on a 0-100 viewBox stretched to the container,
          so no width measurement is needed. `vector-effect: non-scaling-stroke`
          keeps it a true 2px however far the box is stretched - without it the
          horizontal scaling would smear the stroke into a wedge.
          Dots and hover targets are HTML on top, positioned in percentages, so
          they stay circular and keep a finger-sized hit area the SVG scaling
          would otherwise squash. */}
      <div className="relative h-[150px]" role="img"
           aria-label={`${metric} per ${bucket}, ${total} total`}>
        <svg className="absolute inset-0 h-full w-full overflow-visible"
             viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {/* Recessive baseline; no gridlines - at this size they would out-weigh
              the one line that carries the data. */}
          <line x1="0" y1="100" x2="100" y2="100" stroke="var(--line)" strokeWidth="1"
                vectorEffect="non-scaling-stroke" />
          {pts.length > 1 && (
            <>
              <path d={`${line} L 100 100 L 0 100 Z`} fill="var(--listen)" opacity="0.08" />
              <path d={line} fill="none" stroke="var(--listen)" strokeWidth="2"
                    strokeLinejoin="round" strokeLinecap="round"
                    vectorEffect="non-scaling-stroke" />
            </>
          )}
        </svg>

        <div className="absolute inset-0 flex">
          {bars.map((b, i) => {
            const v = b[metric]
            const x = pts.length > 1 ? (i / (pts.length - 1)) * 100 : 50
            const y = 100 - (v / max) * 100
            return (
              <div key={b.key} className="group relative h-full flex-1">
                {/* Marker: 9px, so it clears the 8px minimum on its own. */}
                <div
                  className="pointer-events-none absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--listen)] opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ left: `${x}%`, top: `${y}%` }}
                />
                {pts.length === 1 && (
                  <div className="pointer-events-none absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--listen)]"
                       style={{ left: `${x}%`, top: `${y}%` }} />
                )}
                {/* Crosshair, drawn only under the hovered point. */}
                <div className="pointer-events-none absolute top-0 bottom-0 w-px -translate-x-1/2 bg-[var(--line)] opacity-0 group-hover:opacity-100"
                     style={{ left: `${x}%` }} />
                <div className="pointer-events-none absolute z-10 hidden -translate-x-1/2 -translate-y-full rounded-md bg-[var(--ink)] px-2 py-1 text-[12px] whitespace-nowrap text-white group-hover:block"
                     style={{ left: `${x}%`, top: `calc(${y}% - 10px)` }}>
                  {v.toLocaleString()} · {b.label}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-2 flex justify-between text-[11.5px] text-[var(--muted-foreground)]">
        <span>{bars[0]?.label}</span>
        <span>{bars[bars.length - 1]?.label}</span>
      </div>

      <table className="sr-only">
        <caption>{metric} per {bucket}</caption>
        <tbody>
          {bars.map((b) => (
            <tr key={b.key}>
              <th scope="row">{b.label}</th>
              <td>{b[metric]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="sr-only">Times shown in {tz}.</span>
    </section>
  )
}

function Toggle<T extends string>({
  value, onChange, options,
}: { value: T; onChange: (v: T) => void; options: { k: T; label: string }[] }) {
  return (
    <div className="flex gap-0.5 rounded-[9px] bg-[var(--wash)] p-0.5">
      {options.map((o) => (
        <button
          key={o.k}
          onClick={() => onChange(o.k)}
          aria-pressed={value === o.k}
          className={
            "rounded-[7px] px-2.5 py-1 text-[12.5px] font-semibold transition-colors " +
            (value === o.k
              ? "bg-white text-[var(--ink)] shadow-[0_1px_2px_rgba(20,23,28,.08)]"
              : "text-[var(--muted-foreground)] hover:text-[var(--ink)]")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * How far back each view reaches. Fixed windows, not "however much data exists":
 * spanning only the days that happen to have usage collapses a new account to a
 * single point in every view, which is a line chart that cannot draw a line.
 * A quiet day is data — it is a zero, and the shape of the run of zeros is most
 * of what a parent is looking at.
 */
const WINDOW_DAYS: Record<Bucket, number> = { day: 30, week: 12 * 7, month: 365 }

/**
 * Server sends one row per day, and only for days with usage. Everything else —
 * filling the window, folding into weeks or months — happens here so the
 * calendar lives in one place.
 */
function group(days: UsageDay[], bucket: Bucket, tz: string) {
  const have = new Map(days.map((d) => [d.date, d]))
  const out = new Map<string, { key: string; label: string; questions: number; tokens: number }>()

  // "Today" in the device's timezone, so the newest point is the day the family
  // is actually living through rather than whatever UTC has rolled over to.
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(new Date())
  const cursor = new Date(todayKey + "T00:00:00Z")
  cursor.setUTCDate(cursor.getUTCDate() - (WINDOW_DAYS[bucket] - 1))
  const end = new Date(todayKey + "T00:00:00Z")

  while (cursor <= end) {
    const dateKey = cursor.toISOString().slice(0, 10)
    const d = have.get(dateKey)
    let key: string, label: string

    if (bucket === "day") {
      key = dateKey
      label = cursor.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
    } else if (bucket === "week") {
      // Monday-anchored, so a "week" matches how a school week reads.
      const mon = new Date(cursor)
      mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7))
      key = mon.toISOString().slice(0, 10)
      label = `w/c ${mon.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`
    } else {
      key = dateKey.slice(0, 7)
      // Four-digit year: "Jul 26" reads as the 26th of July, not July 2026, and
      // sits directly under axis labels that ARE day-of-month in the other modes.
      label = cursor.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" })
    }

    const row = out.get(key) || { key, label, questions: 0, tokens: 0 }
    row.questions += d?.questions || 0
    row.tokens += d?.tokens || 0
    out.set(key, row)

    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return [...out.values()]
}
