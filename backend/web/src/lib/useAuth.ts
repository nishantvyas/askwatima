import { useEffect, useState } from "react"
import { onAuthStateChanged, type User } from "firebase/auth"
import { auth } from "./firebase"

/**
 * `pending` matters: until Firebase has restored the session from storage,
 * currentUser is null and is indistinguishable from signed out. Rendering the
 * sign-in screen during that window makes an already-signed-in parent see a
 * login form flash on every reload.
 */
export function useAuth() {
  const [user, setUser] = useState<User | null>(auth.currentUser)
  const [pending, setPending] = useState(true)

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u)
        setPending(false)
      }),
    [],
  )

  return { user, pending }
}
