import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { releaseDevice } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

const HOLD_MS = 3000

/**
 * Removing a device deletes everything it ever heard and unbinds it, and there
 * is no undo. Two independent gates, because a single confirm is one misclick:
 * the id has to be copied from the card above, which forces the parent to look
 * at WHICH device this is, and the button has to be held down, which cannot be
 * done by accident or by a stray Enter on a focused dialog.
 */
export function RemoveDevice({
  deviceId,
  name,
  onRemoved,
}: {
  deviceId: string
  name: string
  onRemoved: () => Promise<void> | void
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | null>(null)
  const started = useRef(0)

  const matches = typed.trim().toLowerCase() === deviceId.toLowerCase()

  useEffect(() => {
    if (!open) {
      setTyped("")
      setProgress(0)
    }
  }, [open])

  // Any unmount mid-hold has to clear the frame loop, or it keeps running
  // against state that no longer exists.
  useEffect(() => cancel, [])

  function cancel() {
    if (timer.current !== null) cancelAnimationFrame(timer.current)
    timer.current = null
    setProgress(0)
  }

  function tick() {
    const pct = Math.min(1, (performance.now() - started.current) / HOLD_MS)
    setProgress(pct)
    if (pct >= 1) {
      timer.current = null
      void commit()
      return
    }
    timer.current = requestAnimationFrame(tick)
  }

  function hold() {
    if (!matches || busy) return
    started.current = performance.now()
    timer.current = requestAnimationFrame(tick)
  }

  async function commit() {
    setBusy(true)
    try {
      await releaseDevice(deviceId)
      toast.success(`${name || "Device"} removed.`)
      setOpen(false)
      await onRemoved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
      setProgress(0)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="text-[var(--muted-foreground)] hover:text-[var(--destructive)]">
        Remove device
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Remove {name || "this Watima"}?</DialogTitle>
          <DialogDescription>
            Every question and answer it stored is deleted, and the device is unbound from your
            account. It will show a pairing code again. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor={`confirm-${deviceId}`}>
            Type its id — <span className="font-mono">{deviceId}</span>
          </Label>
          <Input
            id={`confirm-${deviceId}`}
            autoComplete="off"
            spellCheck={false}
            placeholder={deviceId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="font-mono"
          />
        </div>

        <DialogFooter className="sm:justify-between">
          <DialogClose className="text-[14.5px] font-semibold text-[var(--muted-foreground)] hover:text-[var(--ink)]">
            Keep it
          </DialogClose>

          <button
            type="button"
            disabled={!matches || busy}
            onPointerDown={hold}
            onPointerUp={cancel}
            onPointerLeave={cancel}
            onPointerCancel={cancel}
            className="relative h-11 min-w-[220px] overflow-hidden rounded-lg bg-[var(--destructive)] px-5 text-[15px] font-semibold text-white select-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 bg-black/25"
              style={{ width: `${progress * 100}%` }}
            />
            <span className="relative">
              {busy
                ? "Removing…"
                : progress > 0
                  ? "Keep holding…"
                  : matches
                    ? "Press and hold to remove"
                    : "Enter the id above"}
            </span>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
