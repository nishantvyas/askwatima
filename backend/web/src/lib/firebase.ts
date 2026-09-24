import { initializeApp } from "firebase/app"
import { getAuth } from "firebase/auth"

// Public by design - a Firebase web API key identifies the project, it does not
// authorise anything. Access is decided by Auth and the Firestore rules.
export const app = initializeApp({
  apiKey: "AIzaSyDUUViLB74Akcw0y0cFkHjUxRHp2TbehxQ",
  // Google's consent screen names the REDIRECT domain, not the app — an
  // anti-phishing measure, and it ignores the "public-facing name" set in
  // Firebase. With the default authDomain a parent was asked to "Sign in to
  // watima-7d274.firebaseapp.com", which looks like a phishing page on a
  // product whose whole pitch is that you can trust it with your child.
  //
  // Pointing authDomain at our own Firebase-hosted domain makes it read
  // "Sign in to askwatima.com". Three things have to be true for this to work,
  // and all three are, so do not change one without the others:
  //   1. askwatima.com is a Firebase Hosting custom domain on THIS project
  //      (it serves /__/auth/handler — verified 200),
  //   2. it has a valid certificate,
  //   3. https://askwatima.com and https://askwatima.com/__/auth/handler are
  //      registered on the OAuth client as an origin and a redirect URI.
  // Miss (3) and every sign-in fails with redirect_uri_mismatch.
  authDomain: "askwatima.com",
  projectId: "watima-7d274",
})

export const auth = getAuth(app)
