import { useCallback, useEffect, useState } from "react"

/**
 * A router, in thirty lines, because this app has three routes.
 *
 * react-router was the first dependency added here and it arrived with a high
 * severity advisory; the whole 6.x/7.x line carries a steady stream of them,
 * almost all in SSR, RSC and single-fetch code paths a static SPA never
 * executes. Carrying that means `npm audit` is permanently red, which trains
 * everyone to ignore it - a worse security position than having no router
 * dependency at all.
 *
 * What is actually needed: current path, navigation that updates history, and
 * the back button. That is the History API, which every browser already ships.
 */
/**
 * The app is built into /app, so Firebase Hosting sees a real directory there
 * and 301s "/app" to "/app/". A fresh load therefore reports a trailing slash
 * while client-side navigation does not, and any `route === "/app"` check is
 * true only half the time. Normalise once, here, rather than at every callsite.
 */
const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p)

export function useRoute(): [string, (to: string, replace?: boolean) => void] {
  const [path, setPath] = useState(() => norm(window.location.pathname))

  useEffect(() => {
    const onPop = () => setPath(norm(window.location.pathname))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const go = useCallback((to: string, replace = false) => {
    const next = norm(to)
    if (next === norm(window.location.pathname)) return
    window.history[replace ? "replaceState" : "pushState"]({}, "", next)
    setPath(next)
    window.scrollTo(0, 0)
  }, [])

  return [path, go]
}
