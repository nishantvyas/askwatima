/**
 * Runs the real `talk` handler on http://127.0.0.1:5555 for local testing.
 *
 *   set -a; . ../../.gemini; set +a
 *   export DEVICE_KEY=whatever
 *   npm run local
 *
 * Then point curl (or the device, via a LAN IP) at it:
 *
 *   curl -X POST http://127.0.0.1:5555/ \
 *     -H "X-Api-Key: $DEVICE_KEY" \
 *     -H "Content-Type: audio/L16;rate=16000;channels=1" \
 *     --data-binary @recording.pcm -D headers.txt -o reply.pcm
 *
 * Prefer this over `firebase emulators:start`: the functions emulator dies with
 * an opaque "Failed to load function" on this setup, while this wraps the same
 * exported handler in the same express/rawBody shape Cloud Run gives it, and
 * surfaces real stack traces.
 */
const express = require("express");

process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));

const { talk } = require("./index.js");

const app = express();
app.use(express.raw({ type: "*/*", limit: "32mb" }));
app.use((req, res, next) => {
  req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  next();
});
app.all("*", (req, res) => {
  try {
    const r = talk(req, res);
    if (r && typeof r.catch === "function") r.catch((e) => console.error("HANDLER REJECTED:", e));
  } catch (e) {
    console.error("HANDLER THREW SYNC:", e);
    if (!res.headersSent) res.status(500).send("harness caught: " + e.message);
  }
});

app.listen(5555, () => console.log("harness listening on 5555"));
