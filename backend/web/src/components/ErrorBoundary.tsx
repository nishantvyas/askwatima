import { Component, type ReactNode } from "react"

/**
 * Without this, one thrown render error unmounts the whole tree and the parent
 * gets a blank white page with nothing to act on and nothing to report. That
 * happened: a menu part used outside its required parent took the entire
 * dashboard down, and the only clue was a minified error code in the console.
 *
 * A boundary cannot make the broken part work, but it keeps the failure local
 * and legible, and leaves a way out.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error("Dashboard crashed:", error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="mx-auto max-w-[560px] px-6 py-20">
        <h1 className="serif mb-3 text-[32px] font-medium tracking-[-0.02em]">
          Something broke on this screen
        </h1>
        <p className="mb-6 text-[var(--muted-foreground)]">
          Your devices and everything they have heard are safe — this is a fault in the page, not
          in your account. Reloading usually clears it.
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => window.location.reload()}
            className="h-11 rounded-lg bg-[var(--ink)] px-5 text-[15px] font-semibold text-white"
          >
            Reload
          </button>
          <a
            href="/app/"
            className="grid h-11 place-items-center rounded-lg border border-[var(--line)] px-5 text-[15px] font-semibold"
          >
            Back to devices
          </a>
        </div>
        <pre className="mt-8 overflow-x-auto rounded-lg bg-[var(--wash)] p-4 font-mono text-[12.5px] text-[var(--muted-foreground)]">
          {error.message}
        </pre>
      </div>
    )
  }
}
