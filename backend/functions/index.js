"use strict";

/**
 * Watima voice backend.
 *
 * Contract with the device (firmware/main/net.cpp):
 *
 *   POST /
 *   X-Api-Key:    <DEVICE_KEY>
 *   Content-Type: audio/L16;rate=16000;channels=1
 *   body:         raw mono PCM16LE @ 16 kHz
 *
 *   200 OK
 *   X-Transcript: <percent-encoded>   what the device heard
 *   X-Answer:     <percent-encoded>   what the model replied
 *   Content-Type: audio/L16;rate=16000;channels=1
 *   body:         raw mono PCM16LE @ 16 kHz, ready to hand to the codec
 *
 * The text rides in headers so the device can render it the moment headers
 * land, while the audio is still streaming down the same connection.
 */

const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { getAuth } = require("firebase-admin/auth");
const { GoogleGenAI, Type } = require("@google/genai");
const { wavFromPcm, resamplePcm16, createResampler, rmsOf, capAnswer } = require("./audio");
const mail = require("./mail");

initializeApp();
const db = getFirestore();

const DEVICE_KEY = defineSecret("DEVICE_KEY");
// Cloudflare Email Sending. Bound on the function below, or every send fails in
// production while working perfectly from a laptop that can read Secret Manager.
const CF_EMAIL_TOKEN = defineSecret("CF_EMAIL_TOKEN");

// Inference runs on Vertex AI, not the Gemini Developer API. The developer
// terms bar using the service "as part of a website, application, or other
// service that is directed towards or is likely to be accessed by individuals
// under the age of 18" - which is precisely what this is. The same document
// states those terms "do not govern your direct use of any Google Cloud
// Platform service"; Vertex is one. That is the whole reason for this surface.
// The models and per-token prices are identical either way.
//
// It also deletes the API key: Vertex authenticates as the function's own
// service account through ADC. Careful - if GEMINI_API_KEY or GOOGLE_API_KEY
// is present in the environment, the SDK short-circuits to the global endpoint
// and silently ignores `location`. GEMINI_API_KEY is therefore deliberately no
// longer bound to this function; unbinding it is load-bearing, not cleanup.
const VERTEX_PROJECT = process.env.GCLOUD_PROJECT || "watima-7d274";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "us-central1";

// One client per process, reused across warm invocations. There is no longer a
// per-request credential that would force a fresh client on every call.
const vertex = new GoogleGenAI({
  vertexai: true,
  project: VERTEX_PROJECT,
  location: VERTEX_LOCATION,
});

// Overridable without a code change: `firebase functions:config` is gone in v2,
// so these read from the environment (set via .env or --set-env-vars).
// gemini-3.6-flash is served ONLY on Vertex's `global` endpoint - no region
// carries it (probed us-east1/4/5, us-west1/4, us-south1, northamerica-northeast1,
// europe-west4). `global` routes to whichever region has capacity and gives no
// residency guarantee, and the request it would carry is the child's raw voice.
// So this drops a model generation to keep that audio inside us-central1.
// Measured on the same spoken question, both transcribed it verbatim and
// answered correctly; 2.4s vs 2.2s, and $0.00230 vs $0.00299 per turn.
const CHAT_MODEL = process.env.CHAT_MODEL || "gemini-2.5-flash";

// Measured, on a real turn: the default TTS model costs $20/M audio tokens and
// this one $10/M for the same sentence in the same generation time (5.9s vs
// 6.0s). TTS was 59% of the cost of a turn, so this alone removes a quarter of
// it. Revisit if the voice quality ever proves worse in the room.
// Same model, but Vertex serves it without the `preview` infix.
const TTS_MODEL = process.env.TTS_MODEL || "gemini-2.5-flash-tts";
const VOICE = process.env.VOICE || "Kore";

// The model spent 447 thinking tokens deciding the capital of Japan - nine
// times the answer itself, billed at the output rate, and 2.4s of a latency
// budget the product cannot afford. These are one-sentence factual answers for
// children; there is nothing to reason about. Dropping to "low" measured 0
// thinking tokens, $0.00393 -> $0.00060, and 4.2s -> 1.8s, with an answer of
// equal quality. The parameter is model-generation specific and they reject
// each other's: 3.x wants thinkingLevel and refuses thinkingBudget, while 2.5
// wants thinkingBudget and refuses thinkingLevel. Changing CHAT_MODEL across
// that boundary means changing this too, or every request 400s.
const THINKING_BUDGET = Number(process.env.THINKING_BUDGET ?? 0);

const DEVICE_RATE = 16000; // device captures and plays at this rate
const TTS_RATE = 24000; // Gemini TTS always returns this
// Bounded by META_ANSWER_MAX (600) in the firmware, which is where the device
// decodes this header into. The device does not display answer text - the
// header exists for logging and for future UI - so clipping it costs nothing
// but overrunning the buffer would.
const MAX_ANSWER_HEADER_CHARS = 560;

// What we actually speak is bounded per request by charsForWords(wordsForAge()),
// since the ceiling has to move with the child's age. There is no module-level
// constant for it on purpose.
// Measured on hardware: a normal-volume utterance at ~20cm reads rms ~880 on
// the ES7210 at AUDIO_MIC_GAIN 35. Kept far below that on purpose - the risk is
// asymmetric. Too high and every utterance takes the "I did not catch that"
// branch, which still returns speech and so looks like a working pipeline while
// never reaching the model. Too low merely wastes a call on silence.
const MIN_RMS = 50;

// Answer length is the single biggest driver of how long the device sits
// silent: TTS time scales almost linearly with it, and a 9-second answer means
// a ~20s wait. Children lose the thread well before that, so brevity here is a
// latency feature, not just a style preference.
// Answer length follows the child's age: a five-year-old wants one sentence, an
// eleven-year-old can follow a real explanation and is bored by a single line.
// Ages outside the range clamp into it rather than extrapolating to something
// silly at either end.
const AGE_RANGE = { min: 5, max: 11 };

// A range, not a single number. Given one figure the model pads to hit it -
// that is exactly how "under 25 words" produced answers that were reliably 25
// words. A band lets it stop when the answer is finished.
//
// The ladder is deliberately not linear. A five-year-old loses the thread of a
// long answer well before it ends, so brevity is the feature; an eleven-year-old
// is short-changed by one sentence and can follow a real explanation. It flattens
// at the top on purpose - past about two minutes of speech even an older child
// stops listening, whatever the subject.
const AGE_WORDS = {
  5:  [25, 30],
  6:  [35, 40],
  7:  [55, 60],
  8:  [75, 80],
  9:  [90, 100],
  10: [100, 110],
  11: [100, 125],
};
const DEFAULT_WORDS = AGE_WORDS[AGE_RANGE.min];

function wordsForAge(age) {
  if (!age) return DEFAULT_WORDS;
  const a = Math.max(AGE_RANGE.min, Math.min(AGE_RANGE.max, age));
  return AGE_WORDS[a] || DEFAULT_WORDS;
}

// Backstop, not a target - capAnswer only trims when the model overshoots the
// top of the band badly. Measured at roughly 5.3 characters per spoken word,
// so this leaves real headroom before anything is cut.
const charsForWords = ([, hi]) => Math.round(hi * 8) + 40;

function systemPromptFor(age) {
  const [lo, hi] = wordsForAge(age);
  const who = age
    ? `You are speaking with a child who is ${age} years old. Pitch the words, the examples and the assumed knowledge for exactly that age.`
    : `You may be speaking to a child or an adult. Assume a curious child if unsure.`;
  const shape = hi <= 40
    ? `Answer in ONE short sentence. Use a second only if the question truly needs it.`
    : `Answer in a few short sentences. Explain it properly, but never pad to fill space.`;

  return `You are Watima, a voice assistant living in a small round
pendant-sized device. People speak to you through a tiny microphone and hear you
through a tiny speaker.

- ${who}
- ${shape}
- Aim for ${lo} to ${hi} words. That is a band, not a target: stop as soon as the
  question is properly answered rather than padding to reach it. A child stops
  listening long before a long answer ends.
- Start with the answer itself. Never open with filler such as "Thank you for
  clarifying", "You are asking about", or "That is a great question".
- Warm and direct. Never use markdown, bullet points, headings, or emoji.
- Spell out numbers, dates, and units the way they should be spoken aloud.
- If the audio is unclear or you hear nothing, say so briefly instead of guessing.
- You may be shown earlier turns of this conversation. Use them to resolve
  references like "it" or "that", but never recap them unless asked.`;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    transcript: {
      type: Type.STRING,
      description: "Verbatim transcription of the user's speech. Empty if nothing intelligible.",
    },
    answer: {
      type: Type.STRING,
      description: "Your spoken reply, at most two short sentences.",
    },
  },
  required: ["transcript", "answer"],
};

// --- conversation memory -------------------------------------------------
// Firestore layout:  conversation/{autoId} = { deviceId, q, a, ts }
//
// A flat collection keyed by a deviceId field rather than a per-device
// subcollection, so history can also be queried across devices later. The
// lookup is `where(deviceId) + orderBy(ts desc) + limit(N)`, which Firestore
// will not serve from single-field indexes - it needs the composite index
// (deviceId ASC, ts DESC) declared in firestore.indexes.json. With that in
// place the read touches only the N documents it returns, no matter how large
// the collection grows.
//
// Only the transcribed question and the spoken answer are stored - no prompts,
// no audio - so documents stay tiny.

const CONVERSATION = "conversation";
const SETTINGS = "deviceSettings";
const HISTORY_TURNS = 6;       // how many past exchanges to feed the model
const HISTORY_MAX_CHARS = 300; // per field, so one rambling turn cannot bloat context

// --- memory posture ------------------------------------------------------
// Switchable per device, because it is a positioning decision as much as a
// product one. California SB 867's exclusion for stand-alone consumer devices
// turns partly on the device NOT "sustain[ing] a relationship across multiple
// interactions" - and persistent, parent-visible history is documentary
// evidence that it does. So the posture has to be changeable without a
// firmware release.
//
//   "off"        no memory at all; every question stands alone.
//   "session"    recent turns, but only from the last SESSION_WINDOW_MIN.
//                Resolves "what is it famous for?" inside one conversation
//                without carrying anything across days. DEFAULT.
//   "persistent" full history, parent-visible. Opt-in.
const MEMORY_MODES = new Set(["off", "session", "persistent"]);
const MEMORY_DEFAULT = "session";
const SESSION_WINDOW_MIN = 60;

// Days a turn survives, per posture. Firestore TTL enforces this server-side.
const RETENTION_DAYS = { off: 0, session: 1, persistent: 30 };

// --- token entitlement ---------------------------------------------------
//
// The balance lives on the ACCOUNT, not the device: a parent buys tokens once
// and every device they own draws from the same pool. Spend is still attributed
// per device (devices/{id}.tokensSpent) so the dashboard can show which one is
// burning it, but there is exactly one number a parent has to understand.
//
// accounts/{uid} = { tokenBalance, granted, spent, updatedAt }
//
// NOTHING CLIENT-SIDE MAY WRITE THIS. Firestore rules deny all client writes to
// the collection; the Admin SDK here bypasses rules, so the only paths that can
// move a balance are this file and a deliberate admin script. When the payment
// system lands it credits through grantTokens() below and nowhere else.
const ACCOUNTS = "accounts";

// --- the reservation queue ------------------------------------------------
//
// Deliberately a SEPARATE collection from `preorders`. That one is keyed by
// email and written by the unauthenticated marketing form; this one is keyed by
// uid and only ever written for a signed-in Google account. Two writers with
// two key shapes in one collection is the thing that would bite later, so they
// stay apart and neither has to know about the other.
const RESERVATIONS = "reservations";
const COUNTERS = "counters";

// Positions start here rather than at 1. This is a display choice and it is the
// ONLY place it is applied.
//
// Read this before changing it: the position and the headcount are deliberately
// two different numbers. `position` is a reservation ID - starting it at a round
// number is ordinary and nobody can check it. `count` is how many people have
// actually reserved, and it is derived from real documents, NOT from the
// position. Wiring the headcount off the offset would mean telling a parent
// "10 people are in the queue" when one person is - a factual claim about
// signups that happens to be false, which is the kind of thing that reads as
// fraud rather than marketing when someone checks. Keep them independent.
const QUEUE_START = 10;

/**
 * Claim the next position, idempotently.
 *
 * Idempotent on uid because this is fired by a button: a double-click, a retry
 * after a flaky network, or a second tab must all yield the SAME position
 * rather than burning two. The read-then-write lives in a transaction so two
 * concurrent joins cannot be handed the same number.
 */
async function joinQueue(uid, email) {
  const resRef = db.collection(RESERVATIONS).doc(uid);
  const ctrRef = db.collection(COUNTERS).doc("reservations");

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(resRef);
    if (existing.exists) return { position: existing.data().position, created: false };

    const ctr = await tx.get(ctrRef);
    const issued = ctr.exists ? Number(ctr.data().issued || 0) : 0;
    const position = QUEUE_START + issued;

    tx.set(ctrRef, { issued: issued + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(resRef, {
      uid,
      email: email || null,
      position,
      at: FieldValue.serverTimestamp(),
    });
    return { position, created: true };
  });
}

/**
 * The parent's email and display name, from Firebase Auth. Null on any failure -
 * a missing recipient must not take down the request that triggered the mail.
 */
async function contactOf(uid) {
  try {
    const u = await getAuth().getUser(uid);
    return { to: u.email || null, name: u.displayName || null };
  } catch {
    return { to: null, name: null };
  }
}

/**
 * Send the welcome email exactly once per account, ever.
 *
 * Called from the three places a new parent can first touch the backend, because
 * there is no "register" endpoint to hook - Google sign-in creates the auth user
 * in the browser, and accounts/{uid} is otherwise written lazily by the token
 * ledger.
 *
 * A transaction, not read-then-set: /api/account is the hottest path in the
 * dashboard and two tabs opening together would both read welcomedAt as absent.
 * Only the transaction that actually claims the flag sends.
 */
async function ensureWelcomed(uid) {
  const ref = db.collection(ACCOUNTS).doc(uid);
  let claimed = false;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && snap.data().welcomedAt) return;
      tx.set(ref, { welcomedAt: FieldValue.serverTimestamp() }, { merge: true });
      claimed = true;
    });
  } catch (e) {
    logger.warn(`welcome: could not claim flag for ${uid}: ${e.message}`);
    return;
  }
  if (!claimed) return;
  const c = await contactOf(uid);
  await mail.fire(mail.welcome(c), "welcome");
}

/** Real signups. Derived from the counter's own tally, never from the offset. */
async function queueCount() {
  const ctr = await db.collection(COUNTERS).doc("reservations").get();
  return ctr.exists ? Number(ctr.data().issued || 0) : 0;
}

// One raw model token, summed across the chat call and the TTS call, is the
// billing unit. It is the unit the models actually report, so the meter cannot
// drift from what Google charges us the way a per-question estimate would.
// Measured Jul 2026: a turn costs ~700-800 tokens for a five-year-old and
// ~2,000 for an eleven-year-old, because answer length is age-banded.
// See docs/PRICING.md.
const OUT_OF_TOKENS_MSG =
  "I have used up all my answers for now. Ask a grown-up to add more, and I will be right back.";

// Synthesised once per instance and reused. Without the cache a device at zero
// would pay for TTS on every button press - which is exactly the balance we
// just told it that it does not have.
let outOfTokensAudio = null;

async function outOfTokensReply(ai) {
  if (!outOfTokensAudio) outOfTokensAudio = await speak(ai, OUT_OF_TOKENS_MSG);
  return outOfTokensAudio;
}

/** Current balance for an account. Missing document means never granted = 0. */
async function balanceOf(uid) {
  if (!uid) return 0;
  try {
    const snap = await db.collection(ACCOUNTS).doc(uid).get();
    return snap.exists ? Number(snap.data().tokenBalance || 0) : 0;
  } catch (err) {
    // Fail OPEN. A Firestore blip must not silence a child's device; the debit
    // below is what actually protects the bill, and it retries on the next turn.
    logger.error(`balance lookup failed for ${uid}`, err);
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Debit a finished turn. `set` with merge, not `update`: the account document
 * does not exist until the first grant or the first debit, and update() throws
 * on a missing document.
 *
 * Allowed to drive the balance negative. Two turns racing each other can each
 * pass the check at zero, and clamping would need a transaction on the hot path
 * to save a few hundred tokens. The overrun is bounded by concurrency.
 */
async function debitTokens(uid, deviceId, tokens) {
  if (!uid || !Number.isFinite(tokens) || tokens <= 0) return;
  const now = FieldValue.serverTimestamp();
  await Promise.all([
    db.collection(ACCOUNTS).doc(uid).set(
      {
        tokenBalance: FieldValue.increment(-tokens),
        spent: FieldValue.increment(tokens),
        updatedAt: now,
      },
      { merge: true },
    ),
    db.collection(DEVICES).doc(deviceId).set(
      { tokensSpent: FieldValue.increment(tokens), lastUsedAt: now },
      { merge: true },
    ),
  ]);
}

/**
 * The only way a balance goes UP. Kept here rather than inline so the payment
 * system has one call site to hit, and so grants are as auditable as debits.
 *
 * Deliberately NOT wired into claiming yet. The marketing page promises a
 * million tokens with the device, which implies granting on claim - but that is
 * a payment decision that belongs next to verifyConsent(), not a side effect of
 * metering. Until then, grants are a deliberate admin action.
 */
async function grantTokens(uid, tokens, reason) {
  if (!uid || !Number.isFinite(tokens) || tokens <= 0) return;
  await db.collection(ACCOUNTS).doc(uid).set(
    {
      tokenBalance: FieldValue.increment(tokens),
      granted: FieldValue.increment(tokens),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  logger.info(`granted ${tokens} tokens to ${uid} (${reason})`);
}

/**
 * Total billable tokens from a model response. Both the chat call and the TTS
 * call report `usageMetadata`; for TTS the audio output is the overwhelming
 * majority of the cost, so if a model generation ever stops reporting it here
 * the meter under-counts by roughly 10x. The breakdown is logged on every turn
 * precisely so that regression is visible rather than silent - reconcile against
 * aiplatform.googleapis.com/publisher/online_serving/token_count in Monitoring.
 */
function tokensUsed(usage) {
  if (!usage) return 0;
  const total = Number(usage.totalTokenCount || 0);
  if (total > 0) return total;
  // Older shapes report the parts but not the sum.
  return (
    Number(usage.promptTokenCount || 0) +
    Number(usage.candidatesTokenCount || 0) +
    Number(usage.thoughtsTokenCount || 0)
  );
}

async function loadSettings(deviceId) {
  try {
    const snap = await db.collection(SETTINGS).doc(deviceId).get();
    const d = snap.exists ? snap.data() : {};
    return {
      memoryMode: MEMORY_MODES.has(d.memoryMode) ? d.memoryMode : MEMORY_DEFAULT,
      age: validAge(d.age),
      timezone: validTz(d.timezone),
    };
  } catch (err) {
    logger.warn(`settings unavailable for ${deviceId}: ${err.message}`);
    return { memoryMode: MEMORY_DEFAULT, age: null, timezone: null };
  }
}

/** null means "not set", which is a valid state - the device still works. */
function validAge(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= AGE_RANGE.min && n <= AGE_RANGE.max ? n : null;
}

/**
 * Timestamps are stored as Firestore server timestamps, which are absolute
 * instants - there is no timezone in the stored data and there should not be.
 * This is purely a display preference: which wall clock to render those
 * instants against when a parent reads the history back.
 *
 * Validated by asking ICU rather than against a hardcoded list, so it accepts
 * any IANA zone the runtime knows and rejects anything it does not.
 */
function validTz(v) {
  if (typeof v !== "string" || !v) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return v;
  } catch {
    return null;
  }
}

// Never let a memory problem break the conversation - if Firestore is
// unreachable or the index is still building, the device behaves statelessly.
// (History is read inline in the handler, in parallel with settings, so the
// extra settings lookup adds no latency. Session windowing is applied in JS
// over at most HISTORY_TURNS documents, which keeps the existing composite
// index sufficient rather than needing a second range clause.)

// Returns the document reference so the token cost can be patched on once TTS
// has finished and the real usage is known. The write still happens early, in
// parallel with synthesis, because that is free wall-clock; only the token
// field arrives late.
async function saveTurn(deviceId, q, a, memoryMode) {
  if (memoryMode === "off") return null; // nothing is written, so nothing is retained
  try {
    const days = RETENTION_DAYS[memoryMode] ?? RETENTION_DAYS[MEMORY_DEFAULT];
    return await db.collection(CONVERSATION).add({
      deviceId,
      q: q.slice(0, HISTORY_MAX_CHARS),
      a: a.slice(0, HISTORY_MAX_CHARS),
      ts: FieldValue.serverTimestamp(),
      // Firestore TTL deletes on this field. Retention becomes a property of
      // the data rather than a promise in a policy document - which is the
      // distinction the FTC drew in the Alexa settlement.
      expireAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    });
  } catch (err) {
    logger.warn(`could not save turn for ${deviceId}: ${err.message}`);
    return null;
  }
}

/**
 * Daily rollup, under the account that pays for it:
 *   accounts/{uid}/daily/{YYYY-MM-DD} = { date, questions, tokens, devices:{id:{questions,tokens}} }
 *
 * A separate rollup rather than aggregating conversation documents, because
 * those are TTL-deleted - one day in the default `session` posture. A chart
 * built on them would be empty for most parents by morning. The rollup holds
 * counts and no question text, so it can outlive the transcript without
 * weakening the deletion promise: there is nothing in it a parent would want
 * erased that erasing the turn did not already remove.
 *
 * Dated in the DEVICE's timezone when one is set. "How many questions today"
 * has to agree with the day the family actually lived through, not UTC.
 */
function dayKey(tz) {
  const now = new Date();
  try {
    // en-CA renders ISO-ish YYYY-MM-DD, which sorts lexicographically.
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(now);
  }
}

async function rollUpUsage(uid, deviceId, tokens, tz) {
  if (!uid) return;
  const date = dayKey(tz);
  // merge:true increments inside a nested map correctly, which keeps the
  // per-device breakdown in one document instead of one per device per day.
  await db
    .collection(ACCOUNTS)
    .doc(uid)
    .collection("daily")
    .doc(date)
    .set(
      {
        date,
        questions: FieldValue.increment(1),
        tokens: FieldValue.increment(tokens),
        devices: {
          [deviceId]: {
            questions: FieldValue.increment(1),
            tokens: FieldValue.increment(tokens),
          },
        },
      },
      { merge: true },
    );
}

// --- device identity -----------------------------------------------------
//
// Identity is DERIVED from the credential, never asserted alongside it.
//
// The old scheme took deviceId from an unauthenticated X-Device-Id header that
// ran parallel to a single shared key. Since that key is a plaintext string in
// every shipped binary - `esptool read_flash | strings` recovers it in about
// two minutes - and wifi MACs are broadcast in every beacon, anyone holding one
// device could read ANY family's conversation history by changing one header.
//
// Worse than reading: history is replayed to the model as alternating
// user/model turns, so writing a forged `model` turn edits what the assistant
// appears to have already said. That is the highest-leverage prompt injection
// there is, and it would let a stranger make another child's device say
// arbitrary things.
//
//   deviceTokens/{sha256(token)} = { deviceId, revoked, issuedAt }
//
// Only the hash is stored. A Firestore export therefore contains no usable
// credential - the same property BYOK was reaching for, applied where it costs
// nothing. Lookup is a keyed get: O(1), no index, and not enumerable.

const DEVICE_TOKENS = "deviceTokens";
const DEVICES = "devices";

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

function bearerOf(req) {
  const m = /^Bearer\s+(.+)$/i.exec((req.get("authorization") || "").trim());
  return m ? m[1].trim() : "";
}

function sanitizeDeviceId(raw) {
  return (raw || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

// Returns { deviceId, ownerUid } or null. The caller must treat null as 401 and
// must never fall back to a header.
//
// Two keyed gets rather than one: the owner could be denormalised onto the token
// document, but that means keeping two copies in sync across claim and release,
// and at ~20ms each running in a request that already spends seconds in a model
// call, the simpler shape is worth more than the round trip.
async function resolveDevice(req) {
  const token = bearerOf(req);
  if (!token) return null;
  try {
    const snap = await db.collection(DEVICE_TOKENS).doc(sha256hex(token)).get();
    if (!snap.exists) return null;
    const d = snap.data();
    if (d.revoked) return null;

    const dev = await db.collection(DEVICES).doc(d.deviceId).get();
    return { deviceId: d.deviceId, ownerUid: dev.exists ? dev.data().ownerUid || null : null };
  } catch (err) {
    logger.error("token lookup failed", err);
    return null;
  }
}

// Devices entitled to inference, which we now always pay for: moving to Vertex
// removed the per-request owner key, so BYOK is no longer possible and every
// served turn lands on our bill. This list is the only thing bounding that, and
// it fails closed - an empty list serves nobody. It is a placeholder for real
// subscription entitlement (see verifyConsent), and it does NOT scale: the day
// a second household claims a device, this has to be replaced rather than
// appended to.
const PROJECT_KEY_DEVICES = new Set(
  (process.env.PROJECT_KEY_DEVICES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function authorized(req, expected) {
  const got = req.get("x-api-key") || "";
  if (!expected || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** HTTP headers cannot carry raw UTF-8; the device percent-decodes these. */
function headerSafe(text, limit) {
  const trimmed = (text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  return encodeURIComponent(trimmed);
}

async function understand(ai, pcm, history, age) {
  const wav = wavFromPcm(pcm, DEVICE_RATE);

  // Past turns replay as plain text; only the current turn carries audio.
  const contents = [];
  for (const t of history) {
    contents.push({ role: "user", parts: [{ text: t.q }] });
    contents.push({ role: "model", parts: [{ text: t.a }] });
  }
  contents.push({
    role: "user",
    parts: [
      { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
      { text: "Transcribe what the user said, then answer them." },
    ],
  });

  const res = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents,
    config: {
      systemInstruction: systemPromptFor(age),
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig: { thinkingBudget: THINKING_BUDGET },
    },
  });

  const usage = res.usageMetadata || null;
  const raw = res.text;
  try {
    const parsed = JSON.parse(raw);
    return {
      transcript: (parsed.transcript || "").trim(),
      answer: (parsed.answer || "").trim(),
      usage,
    };
  } catch (err) {
    logger.warn("model did not return valid JSON, using raw text", { raw });
    return { transcript: "", answer: (raw || "").trim(), usage };
  }
}

/** TTS request body, shared by the unary and streaming paths. */
function ttsRequest(text) {
  return {
    model: TTS_MODEL,
    // The role is required on Vertex - it 400s with "Please use a valid role"
    // where the Developer API silently defaulted it to "user".
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
      },
    },
  };
}

/** One-shot synthesis. Only the short silence nudge uses this now. */
async function speak(ai, text) {
  const res = await ai.models.generateContent(ttsRequest(text));
  const b64 = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error("TTS returned no audio");
  return resamplePcm16(Buffer.from(b64, "base64"), TTS_RATE, DEVICE_RATE);
}

/**
 * Streaming synthesis: audio is forwarded as the model produces it.
 *
 * This is what makes long answers possible at all. Generating a reply in one
 * call costs roughly half its own duration before a single byte exists, so a
 * hundred-word answer left the device silent for 21 seconds. Measured against
 * the same model, the first streamed chunk arrives in about 1.7 seconds and
 * stays there no matter how long the answer runs.
 *
 * Chunks cannot be resampled independently - see createResampler - so one
 * resampler instance spans the whole stream and its tail is flushed at the end.
 *
 * `onAudio` returns true to abandon the stream, which is how a vanished device
 * stops us paying to synthesise the rest of a reply nobody will hear.
 *
 * Returns the last `usageMetadata` seen. Usage arrives on the trailing events,
 * so a stream abandoned early reports whatever it had got to - which UNDER-bills
 * the parent for audio we did partly pay for. That asymmetry is deliberate: the
 * alternative is charging a child's account for a reply that was never heard.
 */
async function speakStream(ai, text, onAudio) {
  const rs = createResampler(TTS_RATE, DEVICE_RATE);
  const stream = await ai.models.generateContentStream(ttsRequest(text));
  let usage = null;

  for await (const ev of stream) {
    if (ev.usageMetadata) usage = ev.usageMetadata;
    for (const part of ev.candidates?.[0]?.content?.parts || []) {
      const b64 = part.inlineData?.data;
      if (!b64) continue;
      const pcm = rs.push(Buffer.from(b64, "base64"));
      if (pcm.length && (await onAudio(pcm))) return usage;
    }
  }

  const tail = rs.flush();
  if (tail.length) await onAudio(tail);
  return usage;
}

// POST /enroll  -  exchange the shared bootstrap key for a per-device token.
//
// This is a BOOTSTRAP, and its limits are worth stating plainly. It is guarded
// only by the shared key, so it is no stronger than that key - which is why
// enrollment is ONE TIME per device. Once a device has enrolled, re-enrollment
// is refused, so an attacker holding the shared key cannot take over a device
// already in the field and inherit its history. What remains open is enrolling
// a device id that has never enrolled.
//
// The durable fix is a per-device secret burned at manufacture (an eFuse HMAC
// key on the ESP32-S3, which firmware can use but cannot read back), so the
// device proves it is the device. That needs a factory flashing step this
// product does not have yet. Until then: one-time enrollment, and every
// enrollment is logged.
//
// Releasing a device (factory reset, resale) means clearing `enrolled` on
// devices/{deviceId} and revoking its token - a deliberate admin action, not
// something the device can do to itself.
async function handleEnroll(req, res) {
  if (!authorized(req, DEVICE_KEY.value())) {
    logger.warn("enroll rejected: bad bootstrap key");
    res.status(401).send("unauthorized");
    return;
  }

  const deviceId = sanitizeDeviceId(req.get("x-device-id"));
  if (!deviceId) {
    res.status(400).send("missing X-Device-Id");
    return;
  }

  const devRef = db.collection(DEVICES).doc(deviceId);
  const existing = await devRef.get();
  if (existing.exists && existing.data().enrolled) {
    // Enrolment stays one-time: the shared bootstrap key is recoverable from any
    // unit's flash, so a second token must never be mintable for a device that
    // is already living in someone's home.
    //
    // A device reset while online retires itself through /unenroll first and so
    // never lands here. This is the offline reset, and the way out is the owner
    // pressing Remove device - which the firmware now says on screen, because
    // otherwise it is an error with no stated remedy.
    logger.warn(`enroll REFUSED for ${deviceId}: already enrolled ` +
                `(${existing.data().ownerUid ? "claimed" : "unclaimed"})`);
    res.status(409).send("already enrolled - remove this device in the dashboard first");
    return;
  }

  const token = crypto.randomBytes(32).toString("base64url");
  await db.collection(DEVICE_TOKENS).doc(sha256hex(token)).set({
    deviceId,
    revoked: false,
    issuedAt: FieldValue.serverTimestamp(),
  });
  await devRef.set(
    { enrolled: true, enrolledAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  logger.info(`enrolled ${deviceId}`);
  res.status(200).json({ token });
}

// --- device claiming ------------------------------------------------------
//
// Binds a physical device to a parent's account. The design constraint is that
// nothing secret may be printed on the box: packaging is readable by warehouse
// staff, retail browsers, anyone who photographs a carton, and anyone who
// processes a return. A sticker code is how "someone claimed my device before I
// opened it" happens.
//
// So the code is generated on demand and shown ON THE DEVICE'S SCREEN. It
// therefore only exists on a powered device in the claimant's physical
// possession, and there is nothing to harvest before the customer plugs it in.
//
//   claimCodes/{code} = { deviceId, expiresAt }     keyed get, no index
//   devices/{deviceId}.ownerUid                     set once, cleared on release
//
// The device authenticates /claim/begin with the token it already has from
// enrolment, so it must prove it is the device before a code is minted for it -
// otherwise anyone could request a code for someone else's deviceId and race
// the real owner.

const CLAIM_CODES = "claimCodes";
const CLAIM_TTL_MS = 10 * 60 * 1000;
const CLAIM_MAX_ATTEMPTS = 10;          // per account per hour

function newClaimCode() {
  // 6 digits from a CSPRNG. Short enough to read off a 1.43" screen; the brute
  // force resistance comes from the rate limit and the 10-minute expiry, not
  // from the length.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

async function handleClaimBegin(req, res) {
  const device = await resolveDevice(req);
  if (!device) {
    res.status(401).send("unauthorized");
    return;
  }
  const devRef = db.collection(DEVICES).doc(device.deviceId);
  const snap = await devRef.get();
  if (snap.exists && snap.data().ownerUid) {
    res.status(200).json({ claimed: true });
    return;
  }

  // One live code per device: minting a new one invalidates the old, so a code
  // glimpsed across a room stops working as soon as the screen refreshes.
  const prev = snap.exists ? snap.data().claimCode : null;
  if (prev) await db.collection(CLAIM_CODES).doc(prev).delete().catch(() => {});

  const code = newClaimCode();
  const expiresAt = Date.now() + CLAIM_TTL_MS;
  await db.collection(CLAIM_CODES).doc(code).set({
    deviceId: device.deviceId,
    expiresAt: new Date(expiresAt),
  });
  await devRef.set({ claimCode: code, claimCodeExpires: new Date(expiresAt) }, { merge: true });

  logger.info(`${device.deviceId}: claim code issued`);
  res.status(200).json({ claimed: false, code, expiresIn: Math.floor(CLAIM_TTL_MS / 1000) });
}

async function handleClaimStatus(req, res) {
  const device = await resolveDevice(req);
  if (!device) {
    res.status(401).send("unauthorized");
    return;
  }
  const snap = await db.collection(DEVICES).doc(device.deviceId).get();
  const owner = snap.exists ? snap.data().ownerUid : null;
  res.status(200).json({ claimed: !!owner });
}

// --------------------------------------------------------------------------
// PAYMENT SEAM
//
// This is where a payment step slots in, and it is deliberately a real function
// rather than a TODO comment so the call site and the recorded shape do not
// change when it is implemented.
//
// Why here specifically: COPPA requires VERIFIABLE parental consent before a
// child's speech may be disclosed to a third party (Google). Email-plus is not
// an available method precisely because of that disclosure. A monetary
// transaction with notification to the account holder IS a recognised method -
// so charging a card during claiming produces compliance-grade consent out of a
// billing step that has to happen anyway.
//
// When implementing: verify the subscription/charge here, and return the method
// and processor reference. The consent record below already has the right
// shape; only `method` changes value.
// --------------------------------------------------------------------------
async function verifyConsent(uid) {
  return { verified: true, method: "none", processorRef: null };
}

async function handleClaimRedeem(req, res) {
  let uid;
  try {
    const idToken = bearerOf(req);
    if (!idToken) throw new Error("no token");
    uid = (await getAuth().verifyIdToken(idToken)).uid;
  } catch {
    res.status(401).send("sign in first");
    return;
  }

  const code = String(req.body?.code || "").replace(/\D/g, "").slice(0, 6);
  if (code.length !== 6) {
    res.status(400).json({ error: "enter the 6-digit code shown on the device" });
    return;
  }

  // Rate limit per account. Six digits is 10^6; without this it is brute
  // forceable in minutes.
  const hour = Math.floor(Date.now() / 3_600_000);
  const attemptRef = db.collection("claimAttempts").doc(`${uid}_${hour}`);
  const attempts = (await attemptRef.get()).data()?.n || 0;
  if (attempts >= CLAIM_MAX_ATTEMPTS) {
    logger.warn(`claim rate limit hit for ${uid}`);
    res.status(429).json({ error: "too many attempts, try again later" });
    return;
  }
  await attemptRef.set(
    { n: FieldValue.increment(1), expireAt: new Date(Date.now() + 2 * 3_600_000) },
    { merge: true },
  );

  const codeSnap = await db.collection(CLAIM_CODES).doc(code).get();
  if (!codeSnap.exists) {
    res.status(404).json({ error: "that code is not valid" });
    return;
  }
  const { deviceId, expiresAt } = codeSnap.data();
  if (expiresAt.toMillis() < Date.now()) {
    await codeSnap.ref.delete().catch(() => {});
    res.status(410).json({ error: "that code has expired - check the device for a new one" });
    return;
  }

  const devRef = db.collection(DEVICES).doc(deviceId);
  const devSnap = await devRef.get();
  if (devSnap.exists && devSnap.data().ownerUid) {
    res.status(409).json({ error: "this device already belongs to an account" });
    return;
  }

  const consent = await verifyConsent(uid);
  if (!consent.verified) {
    res.status(402).json({ error: "payment required" });
    return;
  }

  await devRef.set(
    {
      ownerUid: uid,
      claimedAt: FieldValue.serverTimestamp(),
      claimCode: FieldValue.delete(),
      claimCodeExpires: FieldValue.delete(),
    },
    { merge: true },
  );
  await codeSnap.ref.delete().catch(() => {});

  // Append-only consent log. Written now with method "none" so that when
  // payment lands the record shape is unchanged.
  await db.collection("consentLog").add({
    uid,
    deviceId,
    method: consent.method,
    processorRef: consent.processorRef,
    ip: req.get("x-forwarded-for") || null,
    at: FieldValue.serverTimestamp(),
  });

  logger.info(`${deviceId}: claimed by ${uid} (consent=${consent.method})`);
  await ensureWelcomed(uid);
  const claimant = await contactOf(uid);
  await mail.fire(mail.paired({ ...claimant, deviceId }), "paired");
  res.status(200).json({ ok: true, deviceId });
}

// --- parent-facing API ----------------------------------------------------
//
// Every one of these is scoped by ownership: the caller's uid comes from a
// verified Firebase ID token, and the device must already belong to it. A
// deviceId in a request body is never trusted on its own - the same lesson as
// the device identity fix, applied on the human side.

async function uidFromRequest(req) {
  try {
    const idToken = bearerOf(req);
    if (!idToken) return null;
    return (await getAuth().verifyIdToken(idToken)).uid;
  } catch {
    return null;
  }
}

// Returns the device document only if the caller owns it, else null.
async function ownedDevice(req, deviceId) {
  const uid = await uidFromRequest(req);
  if (!uid || !deviceId) return null;
  const snap = await db.collection(DEVICES).doc(deviceId).get();
  if (!snap.exists || snap.data().ownerUid !== uid) return null;
  return { uid, ref: snap.ref, data: snap.data() };
}

async function handleApiDevices(req, res) {
  const uid = await uidFromRequest(req);
  if (!uid) {
    res.status(401).json({ error: "sign in first" });
    return;
  }
  const snap = await db.collection(DEVICES).where("ownerUid", "==", uid).get();
  const devices = await Promise.all(
    snap.docs.map(async (d) => {
      const settings = await db.collection(SETTINGS).doc(d.id).get();
      return {
        deviceId: d.id,
        name: d.data().name || "",
        claimedAt: d.data().claimedAt?.toMillis?.() || null,
        memoryMode: settings.exists ? settings.data().memoryMode || MEMORY_DEFAULT : MEMORY_DEFAULT,
        age: settings.exists ? validAge(settings.data().age) : null,
        timezone: settings.exists ? validTz(settings.data().timezone) : null,
        tokensSpent: Number(d.data().tokensSpent || 0),
      };
    }),
  );
  res.status(200).json({ devices });
}

// POST /api/reservation        - where am I in the queue (or not in it)
// POST /api/reservation/join   - take a place, idempotently
//
// Both require a signed-in account, which is the whole point: a Google account
// is a real person Google already verified, so the list cannot fill with
// a@b.com and we never spend a send on an address that does not exist.
async function handleReservation(req, res) {
  const uid = await uidFromRequest(req);
  if (!uid) {
    res.status(401).json({ error: "sign in first" });
    return;
  }
  await ensureWelcomed(uid);

  const join = req.path.endsWith("/join") || req.body?.join === true;

  let position = null;
  if (join) {
    const email = await getAuth()
      .getUser(uid)
      .then((u) => u.email || null)
      .catch(() => null);
    let created;
    ({ position, created } = await joinQueue(uid, email));
    logger.info(`reservation: ${uid} -> #${position}${created ? "" : " (already held)"}`);
    // Only on the transaction that actually issued the number. joinQueue is
    // idempotent on uid, so reloading /signin?reserve=1 must not re-send.
    if (created) {
      const c = await contactOf(uid);
      await mail.fire(mail.reserved({ ...c, position }), "reserved");
    }
  } else {
    const snap = await db.collection(RESERVATIONS).doc(uid).get();
    position = snap.exists ? Number(snap.data().position) : null;
  }

  res.status(200).json({
    position,                    // their number; starts at QUEUE_START
    reserved: position !== null,
    count: await queueCount(),   // real signups, NOT position-derived
  });
}

// GET /api/account - the parent's token balance.
//
// Read through the API rather than straight from Firestore in the client, for
// the same reason everything else here is: the uid comes from a verified ID
// token, so a client cannot ask about an account it does not own. The rules file
// denies client writes to accounts/ outright, so this stays read-only by
// construction rather than by convention.
async function handleApiAccount(req, res) {
  const uid = await uidFromRequest(req);
  if (!uid) {
    res.status(401).json({ error: "sign in first" });
    return;
  }
  await ensureWelcomed(uid);

  const snap = await db.collection(ACCOUNTS).doc(uid).get();
  const d = snap.exists ? snap.data() : {};
  res.status(200).json({
    balance: Number(d.tokenBalance || 0),
    granted: Number(d.granted || 0),
    spent: Number(d.spent || 0),
  });
}

async function handleApiHistory(req, res) {
  const deviceId = String(req.body?.deviceId || "");
  const owned = await ownedDevice(req, deviceId);
  if (!owned) {
    res.status(403).json({ error: "not your device" });
    return;
  }
  // Paged newest-first. `before` is the ts of the oldest row the client already
  // has, so "load more" is a cursor rather than a growing limit - the cost of
  // page 5 is the same as page 1.
  const limit = Math.min(Math.max(Number(req.body?.limit) || 20, 1), 100);
  const before = Number(req.body?.before) || 0;

  let q = db.collection(CONVERSATION).where("deviceId", "==", deviceId).orderBy("ts", "desc");
  if (before > 0) q = q.startAfter(new Date(before));

  // One extra row, purely to answer "is there a next page?" without a count.
  const snap = await q.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);

  res.status(200).json({
    turns: docs.map((d) => ({
      q: d.data().q,
      a: d.data().a,
      ts: d.data().ts?.toMillis?.() || null,
      // Absent on turns recorded before metering existed, and on any turn whose
      // patch lost its race with instance shutdown. The UI renders nothing
      // rather than a confident zero.
      tokens: typeof d.data().tokens === "number" ? d.data().tokens : null,
    })),
    more: snap.docs.length > limit,
  });
}

// POST /api/usage - daily rollups for the chart.
//
// Returns raw daily rows and lets the client bucket them into weeks or months.
// The alternative - three server-side groupings - would put the calendar in two
// places and get them out of step the first time one changed.
async function handleApiUsage(req, res) {
  const uid = await uidFromRequest(req);
  if (!uid) {
    res.status(401).json({ error: "sign in first" });
    return;
  }
  const days = Math.min(Math.max(Number(req.body?.days) || 90, 1), 400);
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fromKey = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(from);

  const snap = await db
    .collection(ACCOUNTS)
    .doc(uid)
    .collection("daily")
    .where("date", ">=", fromKey)
    .orderBy("date", "asc")
    .get();

  const deviceId = String(req.body?.deviceId || "");
  res.status(200).json({
    days: snap.docs.map((d) => {
      const v = d.data();
      const per = deviceId ? v.devices?.[deviceId] : null;
      return {
        date: v.date,
        questions: Number((deviceId ? per?.questions : v.questions) || 0),
        tokens: Number((deviceId ? per?.tokens : v.tokens) || 0),
      };
    }),
  });
}

async function handleApiHistoryClear(req, res) {
  const deviceId = String(req.body?.deviceId || "");
  const owned = await ownedDevice(req, deviceId);
  if (!owned) {
    res.status(403).json({ error: "not your device" });
    return;
  }
  // Batched, and looped, because a delete that silently stops at the first page
  // would report success while leaving most of a child's history in place -
  // which is exactly the failure the FTC fined Amazon over.
  let deleted = 0;
  while (true) {
    const page = await db
      .collection(CONVERSATION)
      .where("deviceId", "==", deviceId)
      .limit(300)
      .get();
    if (page.empty) break;
    const batch = db.batch();
    page.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += page.size;
    if (page.size < 300) break;
  }
  logger.info(`${deviceId}: history cleared by owner (${deleted} turns)`);
  res.status(200).json({ deleted });
}

async function handleApiSettings(req, res) {
  const deviceId = String(req.body?.deviceId || "");
  const owned = await ownedDevice(req, deviceId);
  if (!owned) {
    res.status(403).json({ error: "not your device" });
    return;
  }
  // Either field may be sent on its own, so the two controls in the dashboard
  // do not have to know each other's current value to save.
  const patch = {};

  if (req.body?.memoryMode !== undefined) {
    const mode = String(req.body.memoryMode);
    if (!MEMORY_MODES.has(mode)) {
      res.status(400).json({ error: "unknown memory mode" });
      return;
    }
    patch.memoryMode = mode;
  }

  if (req.body?.age !== undefined) {
    // An explicit null or "" clears it - that is how a parent opts back out of
    // age-tuned answers without deleting the device.
    if (req.body.age === null || req.body.age === "") {
      patch.age = null;
    } else {
      const age = validAge(req.body.age);
      if (age === null) {
        res.status(400).json({
          error: `age must be a whole number from ${AGE_RANGE.min} to ${AGE_RANGE.max}`,
        });
        return;
      }
      patch.age = age;
    }
  }

  if (req.body?.timezone !== undefined) {
    if (req.body.timezone === null || req.body.timezone === "") {
      patch.timezone = null;
    } else {
      const tz = validTz(req.body.timezone);
      if (tz === null) {
        res.status(400).json({ error: "unknown time zone" });
        return;
      }
      patch.timezone = tz;
    }
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "nothing to change" });
    return;
  }

  await db.collection(SETTINGS).doc(deviceId).set(patch, { merge: true });
  logger.info(`${deviceId}: settings -> ${JSON.stringify(patch)}`);
  res.status(200).json({ ok: true, ...(await loadSettings(deviceId)) });
}

// Releasing is what makes resale and factory reset safe. Without it a device
// stays bound forever; with it, an owner must deliberately give the device up
// before anyone else can claim it - so a stolen unit is not instantly
// re-claimable by whoever took it.
async function handleApiRelease(req, res) {
  const deviceId = String(req.body?.deviceId || "");
  const owned = await ownedDevice(req, deviceId);
  if (!owned) {
    res.status(403).json({ error: "not your device" });
    return;
  }

  // Revoke every token issued to this device, so the new owner's device cannot
  // be impersonated using a credential the previous owner extracted.
  const toks = await db.collection(DEVICE_TOKENS).where("deviceId", "==", deviceId).get();
  const batch = db.batch();
  toks.docs.forEach((d) => batch.update(d.ref, { revoked: true }));
  await batch.commit();

  await owned.ref.set(
    {
      ownerUid: FieldValue.delete(),
      claimedAt: FieldValue.delete(),
      enrolled: false,          // lets the device enrol again for its new owner
      releasedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // A new child is a new data subject and must not inherit the previous one's
  // conversations.
  await handleApiHistoryClearInternal(deviceId);

  logger.info(`${deviceId}: released by owner`);
  const releaser = await contactOf(owned.uid);
  await mail.fire(mail.reset({ ...releaser, deviceId, source: "dashboard" }), "reset/dashboard");
  res.status(200).json({ ok: true });
}

/**
 * A device erasing itself, announced while it still has the credential to prove
 * who it is.
 *
 * Without this, a factory reset is a dead end. The device throws away its token,
 * comes back up, tries to enrol, and is refused - enrolment is one-time, which
 * is what stops anyone holding the shared bootstrap key (recoverable from any
 * unit's flash) from minting a second token for a device sitting in a stranger's
 * home. The only way out was for the parent to also press Remove device in the
 * dashboard, which nothing tells them to do.
 *
 * Authenticated by the device's own token rather than the shared key, so it can
 * only ever retire itself. That is what makes it safe to reopen enrolment here
 * while still refusing it in handleEnroll.
 *
 * Deliberately the same end state as the dashboard's Remove device: tokens
 * revoked, ownership cleared, history deleted. Two routes to one outcome, so a
 * reset device always comes up asking to be paired, whichever way it got there.
 */
async function handleUnenroll(req, res) {
  const device = await resolveDevice(req);
  if (!device) {
    logger.warn("unenroll rejected: missing, unknown or revoked device token");
    res.status(401).send("unauthorized");
    return;
  }
  const deviceId = device.deviceId;

  // Read the owner BEFORE the write below deletes ownerUid, or there is nobody
  // left to notify. While ownerUid is still set this account still owns the
  // device, so the mail doubles as a security notice: a reset they did not start
  // is something they need to hear about.
  const ownerUid = (await db.collection(DEVICES).doc(deviceId).get()).data()?.ownerUid || null;

  const toks = await db.collection(DEVICE_TOKENS).where("deviceId", "==", deviceId).get();
  const batch = db.batch();
  toks.docs.forEach((d) => batch.update(d.ref, { revoked: true }));
  await batch.commit();

  await db.collection(DEVICES).doc(deviceId).set(
    {
      ownerUid: FieldValue.delete(),
      claimedAt: FieldValue.delete(),
      enrolled: false,
      releasedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // A reset device is on its way to a new child. The previous one's questions
  // must not survive that.
  await handleApiHistoryClearInternal(deviceId);

  logger.info(`${deviceId}: unenrolled by the device itself (factory reset)`);
  if (ownerUid) {
    const owner = await contactOf(ownerUid);
    await mail.fire(mail.reset({ ...owner, deviceId, source: "device" }), "reset/device");
  }
  res.status(200).json({ ok: true });
}

async function handleApiHistoryClearInternal(deviceId) {
  while (true) {
    const page = await db.collection(CONVERSATION).where("deviceId", "==", deviceId).limit(300).get();
    if (page.empty) break;
    const batch = db.batch();
    page.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (page.size < 300) break;
  }
}

// --- firmware distribution ------------------------------------------------
//
// The manifest lives in Firestore rather than a CDN-cached static file, so
// pausing a rollout takes effect on the next request instead of after a cache
// TTL. When a bad build is going out, minutes matter.
//
//   firmware/current = { version, size, sha256, storagePath, rolloutPercent, paused }
//
// The binary is streamed through this function rather than served from a public
// URL, because the image contains the shared bootstrap key - publishing it
// would hand that key to anyone, no hardware required. At fleet scale this
// should become a short-lived signed URL so the bytes bypass the function; the
// device already authenticates the same way either way.
const FIRMWARE_DOC = "firmware/current";
const FW_BUCKET = process.env.FW_BUCKET || "watima-7d274-firmware";

async function handleFwCheck(req, res) {
  const device = await resolveDevice(req);
  if (!device) {
    res.status(401).send("unauthorized");
    return;
  }
  const snap = await db.doc(FIRMWARE_DOC).get();
  if (!snap.exists) {
    res.status(200).json({ version: "", paused: 1 });
    return;
  }
  const m = snap.data();
  logger.info(
    `${device.deviceId}: fw check, running ${req.get("x-fw-version") || "?"}, ` +
      `available ${m.version}, rollout ${m.rolloutPercent}%${m.paused ? " (PAUSED)" : ""}`,
  );
  res.status(200).json({
    version: m.version || "",
    size: m.size || 0,
    sha256: m.sha256 || "",
    rolloutPercent: m.paused ? 0 : m.rolloutPercent ?? 0,
    paused: m.paused ? 1 : 0,
  });
}

async function handleFwDownload(req, res) {
  const device = await resolveDevice(req);
  if (!device) {
    res.status(401).send("unauthorized");
    return;
  }
  const snap = await db.doc(FIRMWARE_DOC).get();
  if (!snap.exists) {
    res.status(404).send("no firmware");
    return;
  }
  const m = snap.data();
  if (m.paused) {
    // Second gate: a device that cached a manifest before the pause still gets
    // stopped here, which is what makes the kill switch actually immediate.
    res.status(409).send("rollout paused");
    return;
  }

  logger.info(`${device.deviceId}: downloading ${m.version} (${m.size} bytes)`);
  res.set("Content-Type", "application/octet-stream");
  if (m.size) res.set("Content-Length", String(m.size));

  await new Promise((resolve) => {
    getStorage()
      .bucket(FW_BUCKET)
      .file(m.storagePath)
      .createReadStream()
      .on("error", (err) => {
        logger.error("firmware stream failed", err);
        if (!res.headersSent) res.status(500);
        res.end();
        resolve();
      })
      .on("end", resolve)
      .pipe(res);
  });
}

exports.talk = onRequest(
  {
    secrets: [DEVICE_KEY, CF_EMAIL_TOKEN],
    timeoutSeconds: 120,
    memory: "512MiB",
    region: "us-central1",
    maxInstances: 5,
  },
  async (req, res) => {
    const started = Date.now();

    // Route before the method check: the firmware download is a GET, because
    // that is what esp_https_ota issues.
    const path = (req.path || "").replace(/\/+$/, "");
    if (path.endsWith("/fw/download")) {
      await handleFwDownload(req, res);
      return;
    }
    if (path.endsWith("/fw/check")) {
      await handleFwCheck(req, res);
      return;
    }

    // The panel is served from a different origin than the function, so the
    // browser preflights anything with an Authorization header.
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("POST raw PCM16 @ 16 kHz");
      return;
    }

    if (path.endsWith("/enroll"))       { await handleEnroll(req, res); return; }
    if (path.endsWith("/unenroll"))     { await handleUnenroll(req, res); return; }
    if (path.endsWith("/claim/begin"))  { await handleClaimBegin(req, res); return; }
    if (path.endsWith("/claim/status")) { await handleClaimStatus(req, res); return; }
    if (path.endsWith("/claim/redeem")) { await handleClaimRedeem(req, res); return; }

    if (path.endsWith("/api/devices"))       { await handleApiDevices(req, res); return; }
    if (path.endsWith("/api/account"))       { await handleApiAccount(req, res); return; }
    if (path.includes("/api/reservation"))   { await handleReservation(req, res); return; }
    if (path.endsWith("/api/history"))       { await handleApiHistory(req, res); return; }
    if (path.endsWith("/api/usage"))         { await handleApiUsage(req, res); return; }
    if (path.endsWith("/api/history/clear")) { await handleApiHistoryClear(req, res); return; }
    if (path.endsWith("/api/settings"))      { await handleApiSettings(req, res); return; }
    if (path.endsWith("/api/release"))       { await handleApiRelease(req, res); return; }

    // Identity comes from the token lookup and nowhere else. Any X-Device-Id
    // on this request is ignored entirely - that is the whole point.
    const device = await resolveDevice(req);
    if (!device) {
      logger.warn("rejected: missing, unknown or revoked device token");
      res.status(401).send("unauthorized");
      return;
    }
    const deviceId = device.deviceId;

    // No verified parent, no collection. An unclaimed device has nobody who has
    // consented to a child's speech being transcribed and sent to Google, so
    // this is a compliance gate rather than a product nicety - and it is why
    // claiming is a hard requirement instead of an onboarding suggestion.
    if (!device.ownerUid) {
      logger.warn(`${deviceId}: rejected - device is not claimed`);
      res.status(403).send("device not claimed");
      return;
    }

    // X-Gemini-Key is ignored now - older firmware still sends one, and there is
    // nowhere for it to go on Vertex.
    //
    // ENTITLEMENT IS THE TOKEN BALANCE, and it is checked below rather than here
    // so the read can ride along with settings and history for free. The
    // PROJECT_KEY_DEVICES allowlist that used to gate this is now only a
    // development bypass: listed devices skip the balance check AND the debit,
    // so a bench unit does not silently drain a real parent's account. It is no
    // longer entitlement - do not re-add it as one. A device that is not listed
    // and has no balance gets spoken words, not a 402: the child pressed a
    // button and deserves to be told why nothing happened.
    const metered = !PROJECT_KEY_DEVICES.has(deviceId);

    const pcm = Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : Buffer.isBuffer(req.body)
        ? req.body
        : null;

    // Upper bound matters as much as the lower one. A legitimate device sends
    // at most AUDIO_MAX_RECORD_SEC (10s) = 320KB; without a cap the platform
    // would hand us up to 32MB, which we then base64 at ~1.33x inside an
    // instance whose memory is shared across every concurrent request.
    const MAX_PCM_BYTES = DEVICE_RATE * 2 * 13; // ~13s of headroom over the device limit
    const declared = Number(req.get("content-length") || 0);
    if (declared > MAX_PCM_BYTES || (pcm && pcm.length > MAX_PCM_BYTES)) {
      res.status(413).send("audio too long");
      return;
    }
    if (!pcm || pcm.length < DEVICE_RATE / 2) {
      res.status(400).send("need at least ~0.25s of PCM16 audio");
      return;
    }

    const seconds = pcm.length / 2 / DEVICE_RATE;
    const level = rmsOf(pcm);
    logger.info(`received ${seconds.toFixed(2)}s of audio, rms ${level.toFixed(0)}`);

    if (level < MIN_RMS) {
      // Saves a model round trip when the mic picked up nothing. Still a 200 so
      // the device speaks the nudge rather than flashing an error.
      const msg = "I did not catch that. Try holding the button a bit longer.";
      try {
        const audio = await speak(vertex, msg);
        res.set("X-Transcript", "");
        res.set("X-Answer", headerSafe(msg, MAX_ANSWER_HEADER_CHARS));
        res.set("Content-Type", `audio/L16;rate=${DEVICE_RATE};channels=1`);
        res.status(200).send(audio);
      } catch (err) {
        logger.error("silence-path TTS failed", err);
        res.status(200).send(Buffer.alloc(0));
      }
      return;
    }

    try {
      // Settings, history and balance in parallel, so none of the three costs
      // any latency the others were not already spending.
      const [settings, historyRaw, balance] = await Promise.all([
        loadSettings(deviceId),
        db
          .collection(CONVERSATION)
          .where("deviceId", "==", deviceId)
          .orderBy("ts", "desc")
          .limit(HISTORY_TURNS)
          .get()
          .catch(() => null),
        metered ? balanceOf(device.ownerUid) : Promise.resolve(Number.POSITIVE_INFINITY),
      ]);

      // Out of tokens: say so out loud and stop. The child hears a sentence they
      // can act on ("ask a grown-up"), which is the entire reason this is spoken
      // audio and not a 402 the firmware would render as a generic failure.
      //
      // This reply is NOT debited. Charging for the message that says the
      // balance is empty would drive it further negative on every press.
      if (balance <= 0) {
        logger.info(`${deviceId}: out of tokens (balance ${balance}), speaking the nudge`);
        try {
          const audio = await outOfTokensReply(vertex);
          res.set("X-Transcript", "");
          res.set("X-Answer", headerSafe(OUT_OF_TOKENS_MSG, MAX_ANSWER_HEADER_CHARS));
          res.set("X-Tokens-Remaining", "0");
          res.set("Content-Type", `audio/L16;rate=${DEVICE_RATE};channels=1`);
          res.status(200).send(audio);
        } catch (err) {
          logger.error("out-of-tokens TTS failed", err);
          res.status(402).send("out of tokens");
        }
        return;
      }
      const memoryMode = settings.memoryMode;
      const age = settings.age;

      let history = [];
      if (memoryMode !== "off" && historyRaw) {
        history = historyRaw.docs.map((d) => d.data()).filter((t) => t.q && t.a);
        if (memoryMode === "session") {
          const cutoff = Date.now() - SESSION_WINDOW_MIN * 60 * 1000;
          history = history.filter((t) => t.ts?.toMillis?.() >= cutoff);
        }
        history.reverse();
      }
      logger.info(
        `${deviceId}: memory=${memoryMode}, age=${age ?? "unset"} ` +
          `(${wordsForAge(age).join("-")}w), ${history.length} turn(s) in context`,
      );

      const { transcript, answer, usage: chatUsage } = await understand(vertex, pcm, history, age);
      const tUnderstood = Date.now();

      // Deliberately NOT logging transcript or answer text. Cloud Logging has
      // its own retention, its own access control, and its own sinks - none of
      // which any "delete my child's history" flow will ever reach. A parent
      // would get a truthful-looking confirmation while the transcripts sat in
      // _Default for another month. Log shape, never content.
      logger.info(
        `${deviceId}: understood ${transcript.length}c -> ${answer.length}c ` +
          `(${tUnderstood - started}ms)`,
      );

      const maxChars = charsForWords(wordsForAge(age));
      const spoken = capAnswer(answer || "Sorry, I do not have an answer for that.", maxChars);
      if (spoken.length < (answer || "").length) {
        logger.info(`answer capped ${answer.length} -> ${spoken.length} chars`);
      }

      // Persist in the background. TTS is about to take several seconds, so the
      // write costs nothing in wall-clock, and a failure here must not stop the
      // device from getting its reply.
      // Resolves to the DocumentReference (or null), so settle() can patch the
      // turn's token cost onto it once TTS has reported real usage.
      const saved = transcript
        ? saveTurn(deviceId, transcript, spoken, memoryMode).catch(() => null)
        : Promise.resolve(null);

      // Text is ready now; TTS still has seconds of work to do. Flush the
      // headers immediately so the device can paint the reply while it waits,
      // rather than staring at THINKING for the whole round trip. The body then
      // goes out chunked (no Content-Length, which we do not know yet).
      res.set("X-Transcript", headerSafe(transcript, MAX_ANSWER_HEADER_CHARS));
      res.set("X-Answer", headerSafe(spoken, MAX_ANSWER_HEADER_CHARS));
      res.set("Content-Type", `audio/L16;rate=${DEVICE_RATE};channels=1`);
      res.status(200);
      res.flushHeaders();

      // Past this point the status line is already on the wire, so a failure
      // can only be signalled by ending the body early. The device keeps the
      // text it was given and simply has nothing to play.
      //
      // The reply is streamed straight from the model to the device: audio is
      // forwarded the moment it exists rather than after the whole answer has
      // been synthesised. Splitting the text into sentences and firing separate
      // calls used to be the trick here, but it cannot help a long answer that
      // is a single sentence, and streaming beats it in every case anyway.
      let totalBytes = 0;
      let firstChunkMs = 0;
      let chunkCount = 0;
      let ttsUsage = null;

      // Both model calls have to settle the bill, including when TTS dies after
      // the headers are on the wire - the chat call was already paid for by
      // then, and dropping it would be a free turn every time a device walks out
      // of range. Awaited, never fire-and-forget: Cloud Run can freeze the
      // instance the moment the response ends, which silently loses the write.
      const settle = async () => {
        if (!metered) return;
        const chat = tokensUsed(chatUsage);
        const tts = tokensUsed(ttsUsage);
        const total = chat + tts;
        logger.info(
          `${deviceId}: tokens chat=${chat} tts=${tts} total=${total} ` +
            `(chat ${JSON.stringify(chatUsage || {})}, tts ${JSON.stringify(ttsUsage || {})})`,
        );
        // The turn document was written before TTS ran, so its cost is patched
        // on here. Independent of the debit: a failed patch costs the parent a
        // number in the history list, a failed debit costs us the inference.
        const turnRef = await saved.catch(() => null);
        await Promise.all([
          debitTokens(device.ownerUid, deviceId, total).catch((err) =>
            logger.error(`debit failed for ${device.ownerUid}`, err),
          ),
          rollUpUsage(device.ownerUid, deviceId, total, settings.timezone).catch((err) =>
            logger.error(`rollup failed for ${device.ownerUid}`, err),
          ),
          turnRef
            ? turnRef.update({ tokens: total }).catch(() => {})
            : Promise.resolve(),
        ]);
      };

      try {
        ttsUsage = await speakStream(vertex, spoken, async (audio) => {
          if (chunkCount === 0) firstChunkMs = Date.now() - tUnderstood;
          chunkCount++;
          totalBytes += audio.length;

          // Respect backpressure: if the socket buffer is full, wait for drain
          // rather than queuing the whole reply in memory.
          //
          // 'drain' alone is a trap. If the device disappears mid-download -
          // a child walks out of wifi range, the battery dies - the socket
          // never drains and that event never fires, so the await hangs until
          // the function times out, pinning a concurrency slot and billing
          // instance time the whole way. Race it against the socket closing.
          if (res.destroyed) return true;
          if (!res.write(audio)) {
            await new Promise((resolve) => {
              const settle = () => {
                res.off("drain", settle);
                res.off("close", settle);
                res.off("error", settle);
                resolve();
              };
              res.once("drain", settle);
              res.once("close", settle);
              res.once("error", settle);
            });
            if (res.destroyed) return true;
          }
          return false;
        });
      } catch (err) {
        logger.error("TTS failed after headers were sent", err);
        res.end();
        await Promise.all([saved, settle()]);
        return;
      }

      logger.info(
        `spoke ${(totalBytes / 2 / DEVICE_RATE).toFixed(2)}s in ${chunkCount} chunk(s), ` +
          `first playable after ${firstChunkMs}ms ` +
          `(tts ${Date.now() - tUnderstood}ms, total ${Date.now() - started}ms)`,
      );
      res.end();
      // Let the instance finish both writes before it can be frozen.
      await Promise.all([saved, settle()]);
    } catch (err) {
      logger.error("talk failed", err);
      if (res.headersSent) res.end();
      else res.status(500).send(String(err?.message || err));
    }
  },
);
