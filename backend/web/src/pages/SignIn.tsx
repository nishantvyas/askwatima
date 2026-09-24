import { useState } from "react"
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth"
import { auth } from "@/lib/firebase"

/** Firebase error codes are not sentences a parent should ever read. */
function readable(code: string): string {
  switch (code) {
    case "auth/account-exists-with-different-credential":
      // Should not happen while one-account-per-email is on, since Google
      // verifies the address and Firebase links it. Worth a real sentence
      // anyway: if it ever fires, the parent is locked out and needs to know
      // it is us, not them.
      return "There's already an account with that email. Get in touch and I'll merge them."
    case "auth/popup-blocked":
      return "Your browser blocked the sign-in window. Allow pop-ups for this site and try again."
    case "auth/network-request-failed":
      return "Couldn't reach Google. Check your connection and try again."
    case "auth/too-many-requests":
      return "Too many attempts. Wait a minute and try again."
    default:
      return "Something went wrong. Try again."
  }
}

/**
 * Google only.
 *
 * Email/password is gone deliberately, and it removes four things at once:
 * inventing a password, resetting a forgotten one, verifying the address, and
 * the whole class of "is this a real person" problem on the reservation queue.
 * Google has already proved the address exists, so a place in the queue costs
 * us nothing to honour and no send ever bounces.
 *
 * The consequence, stated plainly because it is not reversible from this file:
 * any account created with a password before this can no longer sign in HERE.
 * Firebase's one-account-per-email setting means signing in with Google using
 * the same address links to the existing uid rather than making a new one, so
 * devices and token balances follow the parent across. If that ever fails, the
 * fix is a uid migration in Firestore, not a lost account.
 */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  async function withGoogle() {
    setBusy(true)
    setErr("")
    try {
      await signInWithPopup(auth, new GoogleAuthProvider())
      onDone()
    } catch (e) {
      const code = (e as { code?: string }).code || ""
      // Closing the popup is a decision, not a failure — telling someone who
      // deliberately cancelled that something went wrong is just noise.
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        setBusy(false)
        return
      }
      setErr(readable(code))
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-[440px] px-6 py-16">
      <h1 className="serif mb-2 text-[38px] leading-tight font-medium tracking-[-0.02em]">
        Sign in
      </h1>
      <p className="mb-8 text-[var(--muted-foreground)]">
        One account holds your devices, your tokens, and everything they've been asked.
      </p>

      <button
        type="button"
        onClick={withGoogle}
        disabled={busy}
        className="flex w-full items-center justify-center gap-3 rounded-[12px] border border-[var(--line)] bg-white px-4 py-3.5 text-[15.5px] font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--wash)] disabled:opacity-50"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
          <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.96H.96a9 9 0 0 0 0 8.08l3.01-2.32Z" />
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.32C4.68 5.16 6.66 3.58 9 3.58Z" />
        </svg>
        {busy ? "One moment…" : "Continue with Google"}
      </button>

      {err && <p className="mt-4 text-[15px] text-[var(--destructive)]">{err}</p>}

      <p className="mt-6 text-[14.5px] leading-relaxed text-[var(--muted-foreground)]">
        There's no password to invent and none to reset — signing in and creating an account are
        the same click. I only ever see your name and email address.
      </p>
    </div>
  )
}
