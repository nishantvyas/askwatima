#!/usr/bin/env node
/**
 * Credit tokens to an account. THE ONLY WAY A BALANCE GOES UP until the payment
 * system lands.
 *
 *   node tools/grant-tokens.js --device 9888e00e2ee8 --tokens 1000000 --reason "test grant"
 *   node tools/grant-tokens.js --uid 8hmA...G03    --tokens 1000000 --reason "test grant"
 *   node tools/grant-tokens.js --device 9888e00e2ee8            # read-only, shows balance
 *
 * Deliberately a script and not an endpoint. A balance is money: the set of
 * things that can move it should be small, obvious, and require someone to have
 * service-account credentials on purpose. When Stripe lands it calls
 * grantTokens() in functions/index.js on a verified webhook - not this.
 *
 * Accounts are keyed by ownerUid, not by device. --device is a convenience that
 * resolves devices/{id}.ownerUid first, because that is how you think about it
 * ("give my device a million") and not how it is stored.
 */
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const deviceId = arg("device");
const uidArg = arg("uid");
const tokens = arg("tokens") ? Number(arg("tokens")) : null;
const reason = arg("reason") || "manual grant";

if (!deviceId && !uidArg) {
  console.error("need --device <id> or --uid <uid>");
  process.exit(1);
}
if (tokens !== null && (!Number.isFinite(tokens) || tokens <= 0)) {
  console.error("--tokens must be a positive number");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: "watima-7d274" });
const db = getFirestore();

(async () => {
  let uid = uidArg;
  if (!uid) {
    const dev = await db.collection("devices").doc(deviceId).get();
    if (!dev.exists) throw new Error(`no such device: ${deviceId}`);
    uid = dev.data().ownerUid;
    if (!uid) throw new Error(`device ${deviceId} is not claimed - nobody to credit`);
    console.log(`device ${deviceId} -> account ${uid}`);
  }

  const ref = db.collection("accounts").doc(uid);
  const before = await ref.get();
  const had = before.exists ? Number(before.data().tokenBalance || 0) : 0;

  if (tokens === null) {
    console.log(`balance: ${had.toLocaleString()} tokens (no --tokens given, nothing changed)`);
    return;
  }

  // merge:true, not update(): the document does not exist until the first grant.
  await ref.set(
    {
      tokenBalance: FieldValue.increment(tokens),
      granted: FieldValue.increment(tokens),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const after = await ref.get();
  console.log(
    `granted ${tokens.toLocaleString()} (${reason})\n` +
      `  ${had.toLocaleString()} -> ${Number(after.data().tokenBalance).toLocaleString()} tokens`,
  );
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
