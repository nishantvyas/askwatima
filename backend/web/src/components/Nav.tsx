import { signOut } from "firebase/auth"
import { auth } from "@/lib/firebase"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChevronDown, Check } from "lucide-react"

export function Nav({
  email,
  route,
  onNavigate,
}: {
  email: string | null
  /** Current path, so the menu can mark where you already are. */
  route?: string
  onNavigate?: (path: string) => void
}) {
  return (
    <nav className="border-b border-[var(--line)]">
      <div className="mx-auto flex h-[72px] max-w-[1120px] items-center justify-between px-6">
        {/* Signed in, the logo goes to the dashboard rather than the sales page. */}
        <a
          href={email ? "/app" : "/"}
          className="serif flex items-center gap-2.5 text-[22px] font-semibold tracking-[-0.02em] text-[var(--ink)]"
        >
          {/* The device: dark disc, lit ring, point of light. Same three shapes
              as the favicon and the avatar on each device card. */}
          <span className="grid size-[17px] place-items-center rounded-full border-[2.5px] border-[var(--listen)] bg-[#0A0B0D]">
            <span className="block size-[5px] rounded-full bg-[var(--listen)]" />
          </span>
          watima
        </a>

        {email ? (
          <DropdownMenu>
            {/* Base UI composes with `render`, not Radix's `asChild`. */}
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="text-[15px] font-medium text-[var(--muted-foreground)]"
                />
              }
            >
              Account
              <ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {/* A plain div, not DropdownMenuLabel: that maps to Base UI's
                  GroupLabel, which throws unless it sits inside a Menu.Group.
                  This is the account it belongs to, not a heading for a set of
                  items, so the grouping would have been fiction anyway. */}
              <div className="px-2 py-1.5 text-[13.5px] break-all text-[var(--muted-foreground)]">
                {email}
              </div>
              <DropdownMenuSeparator />
              {/* Navigation lives here rather than in a tab strip: with two
                  destinations a strip spent a full row of the page restating
                  where you already were. Devices is the dashboard. */}
              {onNavigate && (
                <>
                  <DropdownMenuItem
                    onClick={() => onNavigate("/app")}
                    aria-current={route === "/app" || route?.startsWith("/app/pair") ? "page" : undefined}
                  >
                    Devices
                    {(route === "/app" || route?.startsWith("/app/pair")) && (
                      <Check className="ml-auto size-4" />
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onNavigate("/app/history")}
                    aria-current={route?.startsWith("/app/history") ? "page" : undefined}
                  >
                    History
                    {route?.startsWith("/app/history") && <Check className="ml-auto size-4" />}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {/* onClick, not onSelect. Base UI's Menu.Item has no onSelect —
                  that is Radix's name for it. Because Item renders a <div>,
                  `onSelect` is still a valid React DOM prop (the text-selection
                  event), so it type-checks, warns about nothing, binds to an
                  event a menu item never fires, and sign-out silently does
                  nothing. */}
              <DropdownMenuItem
                onClick={async () => {
                  await signOut(auth)
                  window.location.href = "/"
                }}
              >
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <a href="/signin" className="text-[15px] font-medium text-[var(--muted-foreground)]">
            Sign in
          </a>
        )}
      </div>
    </nav>
  )
}
