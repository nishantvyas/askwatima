import type { Account } from "@/lib/api"

/**
 * Tokens mean nothing to a parent on their own, so the headline is questions.
 * The token count is shown underneath because it is what we actually meter and
 * what a top-up is denominated in - hiding it would make the balance feel
 * arbitrary the first time it moved by an amount they did not expect.
 *
 * The estimate is deliberately a RANGE, not a single number. Answer length is
 * age-banded (index.js AGE_WORDS), so the same balance is worth ~1,700 questions
 * to a five-year-old and ~800 to an eleven-year-old. Quoting one figure would be
 * wrong for most of the age range this product supports. See docs/PRICING.md.
 *
 * Measured Jul 2026 against the TTS model directly: audio output tokens run
 * 38 + 1.56 per answer character - there is a fixed per-call overhead, so the
 * relationship is sublinear rather than the flat per-char rate first assumed.
 * A turn is that plus ~344 fixed chat tokens (system prompt, history, the
 * child's recorded voice). Re-measure if CHAT_MODEL or TTS_MODEL changes.
 */
const TOKENS_PER_Q_YOUNG = 585
const TOKENS_PER_Q_OLD = 1226

export function Balance({ account, shared = false }: { account: Account | null; shared?: boolean }) {
  if (!account) return null

  const { balance } = account
  const empty = balance <= 0
  const low = !empty && balance < TOKENS_PER_Q_OLD * 25 // ~25 questions at the worst rate

  const hi = Math.floor(balance / TOKENS_PER_Q_YOUNG)
  const lo = Math.floor(balance / TOKENS_PER_Q_OLD)

  return (
    <div
      className={
        "mb-9 rounded-[18px] border p-5 " +
        (empty
          ? "border-[#F3CFC9] bg-[#FDF0EE]"
          : low
            ? "border-[#F0DCBE] bg-[#FFF3E2]"
            : "border-[var(--line)] bg-[var(--wash)]")
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[13.5px] font-semibold tracking-[0.14em] text-[var(--muted-foreground)]">
          BALANCE
        </p>
        <p className="text-[13.5px] text-[var(--muted-foreground)]">
          {balance.toLocaleString()} tokens
        </p>
      </div>

      <p className="serif mt-1 text-[30px] leading-tight font-medium tracking-[-0.02em]">
        {empty ? "Out of tokens" : `About ${lo.toLocaleString()}–${hi.toLocaleString()} questions`}
      </p>

      <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--muted-foreground)]">
        {empty ? (
          <>
            The device will tell your child to ask you for more, and won't answer again until you
            top up.
          </>
        ) : (
          <>
            The range is the age you've set: a younger child gets shorter answers, so their tokens
            go further.
            {shared && " This balance is shared across all your devices."}
          </>
        )}
      </p>
    </div>
  )
}
