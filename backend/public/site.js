/**
 * The marketing page, and only the marketing page.
 *
 * Sign-in and the dashboard moved to the React bundle under /app. This file
 * deliberately loads no Firebase SDK: the one page that has to be fast on a
 * cold visit should not pay for an auth library it never calls. "Sign in" is a
 * plain link to /signin, and the app redirects an already-signed-in parent
 * straight to their devices.
 */

const API = "https://us-central1-watima-7d274.cloudfunctions.net/talk";
const $ = (id) => document.getElementById(id);
const note = (el, msg, kind) => {
  el.className = "note" + (msg ? " " + kind : "");
  el.textContent = msg || "";
};

/* ------------------------------------------------------------------- hero */
// The first two questions are the ones a five-year-old actually asks, and
// the last two are the questions an eight- to eleven-year-old brings home.
const SCRIPT = [
  { q: "Why is the sky blue?", a: "Sunlight scatters off the air, and blue scatters the most." },
  { q: "How do planes stay up?", a: "Their wings push air downwards, and the air pushes back hard enough to lift them." },
  { q: "Why did the dinosaurs die?", a: "An asteroid struck Earth about sixty-six million years ago and changed the climate." },
  { q: "What is a black hole?", a: "A place where gravity pulls so hard that not even light can escape." },
];

const demo = $("demo"), disc = $("disc"), cap = $("disc-cap"), dnote = $("disc-note");

async function runHero() {
  if (!disc) return;
  const slow = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, slow ? ms * 2 : ms));

  // The device shows state and nothing else - it never displays the answer,
  // so neither does this. Spoken words appear beneath it.
  const step = (state, colour, label, line, quiet) => {
    disc.dataset.s = state;
    demo.style.setProperty("--c", colour);
    cap.textContent = label;
    dnote.textContent = line;
    dnote.classList.toggle("quiet", !!quiet);
  };

  let i = 0;
  for (;;) {
    const { q, a } = SCRIPT[i++ % SCRIPT.length];
    step("rest",   "var(--rest)",   "HOLD TO TALK", "", true);            await wait(1700);
    step("listen", "var(--listen)", "LISTENING",    `“${q}”`);            await wait(2300);
    step("think",  "var(--think)",  "THINKING",     "working it out", 1); await wait(2200);
    step("speak",  "var(--speak)",  "SPEAKING",     `“${a}”`);            await wait(5000);
  }
}
runHero();

/* Preorder form JS removed: both email boxes are now a single link into
   /signin?reserve=1, so the reservation is created against a verified Google
   account rather than a typed address. The unauthenticated /api/preorder
   endpoint still exists server-side but nothing on this page calls it. */

/* -------------------------------------------------------------------- nav */
// The sticky nav has to invert while the dark band is under it, or the
// wordmark and links disappear into it.
addEventListener("scroll", () => {
  const nav = $("nav");
  nav.classList.toggle("stuck", scrollY > 8);
  const band = $("parents");
  if (!band) return nav.classList.remove("on-ink");
  const r = band.getBoundingClientRect();
  nav.classList.toggle("on-ink", r.top <= 70 && r.bottom >= 70);
});
