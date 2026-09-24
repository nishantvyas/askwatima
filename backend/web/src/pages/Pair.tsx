import { useState } from "react"
import { toast } from "sonner"
import { redeemClaim } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function Pair({ first, onPaired }: { first: boolean; onPaired: () => Promise<void> | void }) {
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (code.length !== 6) return setErr("Enter the six digits shown on the device.")
    setBusy(true)
    setErr("")
    try {
      await redeemClaim(code)
      toast.success("Paired. The device is restarting and will be ready in a moment.")
      setCode("")
      await onPaired()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <h3 className="text-[19px] font-bold tracking-[-0.015em]">
          {first ? "Pair your first Watima" : "Pair another Watima"}
        </h3>
        <p className="mt-1.5 text-[15.5px] text-[var(--muted-foreground)]">
          Turn the device on. Once it is on your wi-fi it shows a six-digit code — type it here.
        </p>

        <form onSubmit={submit} className="mt-5">
          <Label htmlFor="code" className="text-[13px] font-semibold tracking-[0.02em]">
            Pairing code
          </Label>
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            placeholder="000000"
            value={code}
            // Digits only: the device shows digits, and a stray space is a
            // confusing failure for something typed off a tiny screen.
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              setErr("")
            }}
            className="mt-2 h-auto py-4 text-center font-mono text-[34px] tracking-[0.35em]"
          />

          {err && <p className="mt-3 text-[14.5px] text-[var(--destructive)]">{err}</p>}

          <Button
            type="submit"
            disabled={busy || code.length !== 6}
            className="mt-4 h-12 w-full text-[15px]"
          >
            {busy ? "Pairing…" : "Pair device"}
          </Button>
        </form>

        {/* "Don't have one yet? Reserve a place." used to live here, pointing at
            the marketing page's #preorder anchor. The Reserve card now sits
            directly above this one and does the same job in place, without a
            round trip out of the dashboard — so this was two calls to action for
            one decision, the weaker of which navigated away. */}
      </CardContent>
    </Card>
  )
}
