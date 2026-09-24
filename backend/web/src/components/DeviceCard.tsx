import { useState } from "react"
import { toast } from "sonner"
import type { Device, MemoryMode } from "@/lib/api"
import { clearHistory, saveSettings } from "@/lib/api"
import { RemoveDevice } from "@/components/RemoveDevice"
import { AGES, AGE_WORDS, MEMORY, TIMEZONES, ageWhy, browserTz, nowIn } from "@/lib/settings"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

// Radix throws on an empty Select value, so "not set" needs a real sentinel.
const UNSET = "unset"

const RING: Record<MemoryMode, string> = {
  off: "var(--rest)",
  session: "var(--listen)",
  persistent: "var(--think)",
}

function Setting({
  title,
  why,
  children,
}: {
  title: string
  why: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-6 first:mt-0">
      <b className="block text-[15.5px] tracking-[-0.01em]">{title}</b>
      <p className="mt-1.5 mb-3 text-[13.5px] leading-relaxed text-[var(--muted-foreground)]">
        {why}
      </p>
      {children}
    </div>
  )
}

export function DeviceCard({
  device,
  onChanged,
}: {
  device: Device
  onChanged: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const mem = MEMORY[device.memoryMode]

  async function patch(p: Parameters<typeof saveSettings>[1]) {
    setBusy(true)
    try {
      await saveSettings(device.deviceId, p)
      await onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={busy ? "opacity-60 transition-opacity" : "transition-opacity"}>
      <CardContent className="p-6">
        <div className="flex items-center gap-4">
          <span
            className="grid size-[62px] shrink-0 place-items-center rounded-full border-[3px] bg-[#0A0B0D]"
            style={{ borderColor: RING[device.memoryMode] }}
          >
            <span
              className="block size-[19px] rounded-full"
              style={{ background: RING[device.memoryMode] }}
            />
          </span>
          <div>
            <div className="text-[19.5px] font-bold tracking-[-0.015em]">
              {device.name || "Watima"}
            </div>
            <div className="font-mono text-[12.5px] text-[#767F8A]">{device.deviceId}</div>
          </div>
        </div>

        <div className="mt-6">
          <Setting
            title="Following a conversation"
            why={`Lets your child ask “but why?” straight after “what is the sky made of?” without starting again. Watima keeps only what it could use to follow along, so this also decides how long anything is stored.`}
          >
            <div
              role="group"
              aria-label="How long this device can follow a conversation"
              className="flex gap-1.5 rounded-xl bg-[var(--wash)] p-1.5"
            >
              {(Object.keys(MEMORY) as MemoryMode[]).map((k) => (
                <button
                  key={k}
                  aria-pressed={k === device.memoryMode}
                  onClick={() => patch({ memoryMode: k })}
                  className={
                    "flex-1 rounded-[9px] px-1 py-2.5 text-[13.5px] font-semibold transition-colors " +
                    (k === device.memoryMode
                      ? "bg-white text-[var(--ink)] shadow-[0_1px_3px_rgba(20,23,28,.08)]"
                      : "text-[var(--muted-foreground)] hover:text-[var(--ink)]")
                  }
                >
                  {MEMORY[k].label}
                </button>
              ))}
            </div>
            <p
              className="mt-3 text-[15px] font-semibold"
              style={{ color: RING[device.memoryMode] }}
            >
              {mem.says}
            </p>
          </Setting>

          <Setting
            title="How long its answers are"
            why="Younger children lose the thread of a long answer before it ends. Older ones can follow a real explanation — but nobody keeps listening forever, so it stops climbing near the top."
          >
            <div className="flex flex-wrap items-center gap-3">
              <Label htmlFor={`age-${device.deviceId}`} className="text-[14.5px] font-semibold">
                Answers for a
              </Label>
              <Select
                value={device.age ? String(device.age) : UNSET}
                onValueChange={(v) => patch({ age: v === UNSET ? null : Number(v) })}
              >
                <SelectTrigger id={`age-${device.deviceId}`} className="w-[190px] max-w-full">
                  {/* Base UI renders the raw value unless told otherwise; the
                      dropdown rows carry the word counts, the trigger stays short. */}
                  <SelectValue>
                    {(v) => (v === UNSET ? "child of any age" : `${v} year old`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSET}>child of any age</SelectItem>
                  {AGES.map((a) => (
                    <SelectItem key={a} value={String(a)}>
                      {a} year old — {AGE_WORDS[a][0]}–{AGE_WORDS[a][1]} words
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="w-full text-[13.5px] text-[var(--muted-foreground)]">
                {ageWhy(device.age)}
              </span>
            </div>
          </Setting>

          <Setting
            title="Time zone"
            why="Times are recorded in UTC and shown in this zone, so History reads the way the day actually happened wherever the device lives."
          >
            <div className="flex flex-wrap items-center gap-3">
              <Label htmlFor={`tz-${device.deviceId}`} className="text-[14.5px] font-semibold">
                Show times in
              </Label>
              <Select
                value={device.timezone ?? UNSET}
                onValueChange={(v) => patch({ timezone: v === UNSET ? null : v })}
              >
                <SelectTrigger id={`tz-${device.deviceId}`} className="w-[300px] max-w-full">
                  <SelectValue>
                    {(v) =>
                      v === UNSET
                        ? `${browserTz} (this browser)`
                        : String(v).replace(/_/g, " ")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-[320px]">
                  <SelectItem value={UNSET}>{browserTz} (this browser)</SelectItem>
                  {TIMEZONES.map((z) => (
                    <SelectItem key={z} value={z}>
                      {z.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="w-full text-[13.5px] text-[var(--muted-foreground)]">
                {device.timezone ? nowIn(device.timezone) : "Following this browser"}
              </span>
            </div>
          </Setting>
        </div>

        <Separator className="mt-6" />

        {/* No "see its history" here - History is a tab of its own now, and two
            routes to one screen is just a thing to keep in sync. */}
        <div className="mt-4 flex flex-wrap gap-5 text-[14.5px] font-semibold">
          <Confirm
            trigger="Delete all conversations"
            title={`Delete every conversation from ${device.name || "this Watima"}?`}
            body="Every question and answer stored for this device is removed. The device itself stays paired. This cannot be undone."
            action="Delete them all"
            onConfirm={async () => {
              const r = await clearHistory(device.deviceId)
              toast.success(
                r.deleted
                  ? `Deleted ${r.deleted} conversation${r.deleted === 1 ? "" : "s"}.`
                  : "There was nothing stored.",
              )
              await onChanged()
            }}
          />

          <RemoveDevice
            deviceId={device.deviceId}
            name={device.name}
            onRemoved={onChanged}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function Confirm({
  trigger,
  title,
  body,
  action,
  onConfirm,
}: {
  trigger: string
  title: string
  body: string
  action: string
  onConfirm: () => Promise<void>
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger className="text-[var(--muted-foreground)] hover:text-[var(--destructive)]">
        {trigger}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            className="bg-[var(--destructive)] text-white hover:bg-[var(--destructive)]/90"
            onClick={async () => {
              try {
                await onConfirm()
              } catch (e) {
                toast.error((e as Error).message)
              }
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
