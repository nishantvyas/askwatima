/**
 * Transactional mail.
 *
 * Cloudflare Email Sending over SMTP. The username is the literal string
 * "api_token" - not the address, not the domain; the server rejects both with
 * `535 5.7.8 use 'api_token' as username`, which is the only place that is
 * documented. The password is the Cloudflare API token in CF_EMAIL_TOKEN.
 *
 * Every send here is best-effort. A parent's reservation, pairing or reset is
 * already committed to Firestore by the time we get here, and failing their
 * request because a mail server was slow would be the wrong trade. Callers use
 * `fire()`, which swallows and logs.
 */
const nodemailer = require("nodemailer");
const logger = require("firebase-functions/logger");

const FROM = "Watima <hello@askwatima.com>";
const REPLY_TO = "hello@askwatima.com";
const SITE = "https://askwatima.com";

let transport = null;
function tx() {
  if (transport) return transport;
  const pass = process.env.CF_EMAIL_TOKEN;
  if (!pass) throw new Error("CF_EMAIL_TOKEN is not bound to this function");
  transport = nodemailer.createTransport({
    host: "smtp.mx.cloudflare.net",
    port: 465,
    secure: true,                 // implicit TLS; 587+STARTTLS is not offered
    auth: { user: "api_token", pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
}

/**
 * Send and never throw.
 *
 * ALWAYS await this, even though the send is best-effort. Functions v2 runs on
 * Cloud Run, which throttles CPU to near-zero the moment the response is sent -
 * a fire-and-forget SMTP round trip races that freeze and lands only when
 * another request happens to keep the instance warm. The result is mail that
 * delivers intermittently and leaves no log line either way, because the
 * logging below never gets to run. The same hazard is why settle() is awaited
 * on both paths of the talk handler.
 *
 * Awaiting costs latency and nothing else: this function try/catches internally,
 * so it cannot throw and cannot fail the request that triggered it.
 */
async function fire(msg, context) {
  if (!msg?.to) {
    logger.warn(`mail: no recipient for ${context}`);
    return;
  }
  try {
    const info = await tx().sendMail({ from: FROM, replyTo: REPLY_TO, ...msg });
    logger.info(`mail: ${context} -> ${msg.to} (${info.messageId})`);
  } catch (e) {
    // Deliberately not rethrown. See the note at the top of the file.
    logger.error(`mail: ${context} failed for ${msg.to}: ${e.message}`);
  }
}

// --- rendering ------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * One wrapper for all four. No images, no web fonts, no tracking pixel - the
 * site promises none of the last one and mail is the easiest place to forget.
 * A single column at 560px renders the same in Gmail, Apple Mail and Outlook
 * without a table layout.
 */
function shell(bodyHtml) {
  return `<div style="margin:0;padding:24px 12px;background:#F0F2EC">
  <div style="max-width:560px;margin:0 auto;padding:32px 30px;background:#FFFFFF;border:1px solid #E5E8E4;border-radius:14px;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
              font-size:16px;line-height:1.62;color:#4E5762">
    <p style="margin:0 0 24px;font-size:15px;font-weight:700;letter-spacing:.18em;color:#0F9D6E">WATIMA</p>
${bodyHtml}
    <p style="margin:32px 0 0;padding-top:18px;border-top:1px solid #E5E8E4;font-size:13.5px;color:#666F7A">
      <a href="${SITE}" style="color:#666F7A">askwatima.com</a> &middot;
      <a href="${SITE}/privacy.html" style="color:#666F7A">Privacy</a> &middot;
      <a href="${SITE}/terms.html" style="color:#666F7A">Terms</a><br>
      Watima is built and run by one person. Replying to this email reaches me, not a queue.
    </p>
  </div>
</div>`;
}

const h = (t) => `    <h1 style="margin:0 0 16px;font-size:23px;line-height:1.25;font-weight:600;color:#14171C">${esc(t)}</h1>`;
const p = (t) => `    <p style="margin:0 0 16px">${t}</p>`;
const b = (t) => `<strong style="color:#14171C">${esc(t)}</strong>`;
const ul = (items) =>
  `    <ul style="margin:0 0 16px;padding-left:20px">${items.map((i) => `<li style="margin:0 0 8px">${i}</li>`).join("")}</ul>`;

const hi = (name) => (name ? `Hi ${name},` : "Hi,");
const firstName = (n) => (n ? String(n).trim().split(/\s+/)[0] : null);

// --- the four messages ----------------------------------------------------

/** 1. Account created. The first thing anyone gets from Watima. */
function welcome({ to, name }) {
  const n = firstName(name);
  return {
    to,
    subject: "Welcome to Watima",
    text: `${hi(n)}

Thanks for signing up. Your Watima account exists now, and it is the thing that will own your device when you have one.

There is no password to remember - you sign in with Google, and that is the whole account.

From here the account is where you:
- pair a device to your family, using the six-digit code the device shows
- read every question your child has asked, and every answer given
- choose how long any of that is kept, or keep none of it
- see your token balance and what it is being spent on

I'm Nishant. I designed Watima, wrote the firmware, and I'm the person who reads replies to this address. If you have a question, just reply.

- Nishant
Mountain View, California
${SITE}`,
    html: shell(
      h("Welcome to Watima") +
        p(esc(hi(n))) +
        p(`Thanks for signing up. Your Watima account exists now, and it is the thing that will ${b("own your device")} when you have one.`) +
        p("There is no password to remember — you sign in with Google, and that is the whole account.") +
        p("From here, the account is where you:") +
        ul([
          "pair a device to your family, using the six-digit code the device shows",
          "read every question your child has asked, and every answer given",
          "choose how long any of that is kept, or keep none of it",
          "see your token balance and what it is being spent on",
        ]) +
        p(`I'm Nishant. I designed Watima, wrote the firmware, and I'm the person who reads replies to this address. If you have a question, just reply.`) +
        p("— Nishant<br>Mountain View, California"),
    ),
  };
}

/** 2. Reserved a place. Sent once, when the queue position is first issued. */
function reserved({ to, name, position }) {
  const n = firstName(name);
  return {
    to,
    subject: `You're #${position} in line for Watima`,
    text: `${hi(n)}

You're in. You are number ${position} in line.

Nothing has been charged, and nothing will be until you actively choose to buy something. Reserving only holds your place.

I build and ship in batches of ten. That is not scarcity marketing - it is how many I can assemble, test and post at a time on my own, and it is why the queue moves in steps rather than continuously. Your number tells you which batch you are in.

What you will hear from me:
- if the timeline moves, I will tell you, including when it slips
- the occasional short note on how the build is going - a photo of a batch, something I learned, a decision I changed my mind about
- one email when I set the final price, and one before your batch ships

That is the whole of it. No weekly newsletter and no sequence. Reply "leave" to this message and I will take you out of the queue and delete the record.

- Nishant
Mountain View, California
${SITE}`,
    html: shell(
      h(`You're #${position} in line`) +
        p(esc(hi(n))) +
        p(`You're in. You are ${b(`number ${position}`)} in line.`) +
        p(`${b("Nothing has been charged")}, and nothing will be until you actively choose to buy something. Reserving only holds your place.`) +
        p(`I build and ship in ${b("batches of ten")}. That isn't scarcity marketing — it's how many I can assemble, test and post at a time on my own, and it's why the queue moves in steps rather than continuously. Your number tells you which batch you're in.`) +
        p("What you'll hear from me:") +
        ul([
          "if the timeline moves, I'll tell you — including when it slips",
          "the occasional short note on how the build is going: a photo of a batch, something I learned, a decision I changed my mind about",
          "one email when I set the final price, and one before your batch ships",
        ]) +
        p(`That's the whole of it — no weekly newsletter, no sequence. Reply ${b("leave")} to this message and I'll take you out of the queue and delete the record.`) +
        p("— Nishant<br>Mountain View, California"),
    ),
  };
}

/** 3. A device was paired to the account. The one email a child is waiting on. */
function paired({ to, name, deviceId }) {
  const n = firstName(name);
  return {
    to,
    subject: "Your Watima is paired — here's how it works",
    text: `${hi(n)}

It's paired. Device ${deviceId} now belongs to your account, and it will answer questions as soon as you hand it over.

How it works, in four steps a five-year-old can follow:
1. Hold the button. The ring turns green while it listens.
2. Ask the question out loud. Anything at all.
3. Let go. The ring turns amber while it works out the answer.
4. Listen. It says a sentence or two, then goes quiet.

That is the whole interaction. There is nothing to scroll, nothing that recommends a next thing, and no wake word - it hears nothing at all unless the button is held.

Two settings worth changing today, in the dashboard at ${SITE}/signin:
- Your child's age. Every answer is written for it. A five-year-old gets a sentence about why the sky is blue; an eleven-year-old gets the actual reason.
- How long questions are kept. Keep nothing, keep a day so follow-ups make sense, or keep 30 days you can read back. You can delete all of it at any time, in one action.

Your token balance is in the dashboard too, along with what has been asked. When it runs out the device says so out loud and stops answering until you top it up - it does not brick, and there is nothing recurring to cancel.

If something doesn't work, reply to this email. It reaches me.

- Nishant
Mountain View, California`,
    html: shell(
      h("It's paired") +
        p(esc(hi(n))) +
        p(`Device ${b(deviceId)} now belongs to your account, and it will answer questions as soon as you hand it over.`) +
        p(b("How it works, in four steps a five-year-old can follow:")) +
        ul([
          `${b("Hold the button.")} The ring turns green while it listens.`,
          `${b("Ask the question out loud.")} Anything at all.`,
          `${b("Let go.")} The ring turns amber while it works out the answer.`,
          `${b("Listen.")} It says a sentence or two, then goes quiet.`,
        ]) +
        p("That's the whole interaction. Nothing to scroll, nothing that recommends a next thing, and no wake word — it hears nothing at all unless the button is held.") +
        p(`Two settings worth changing today, in <a href="${SITE}/signin" style="color:#0F9D6E">the dashboard</a>:`) +
        ul([
          `${b("Your child's age.")} Every answer is written for it. A five-year-old gets a sentence about why the sky is blue; an eleven-year-old gets the actual reason.`,
          `${b("How long questions are kept.")} Keep nothing, keep a day so follow-ups make sense, or keep 30 days you can read back — and delete all of it any time, in one action.`,
        ]) +
        p("Your token balance is in the dashboard too, with what's been asked. When it runs out the device says so out loud and stops answering until you top it up — it doesn't brick, and there's nothing recurring to cancel.") +
        p("If something doesn't work, reply to this email. It reaches me.") +
        p("— Nishant<br>Mountain View, California"),
    ),
  };
}

/**
 * 4. The device was reset - either from the dashboard or on the device itself.
 *
 * Also a security notification: while ownerUid is still set, the account holder
 * is still the owner, so if they did not do this they need to know.
 */
function reset({ to, name, deviceId, source }) {
  const n = firstName(name);
  const how =
    source === "device"
      ? "The reset was started on the device itself."
      : "The reset was started from your dashboard.";
  return {
    to,
    subject: "Your Watima has been reset",
    text: `${hi(n)}

Device ${deviceId} has been reset and is no longer linked to your account. ${how}

What that means, precisely:
- every question and answer stored for this device has been deleted, not hidden
- the credential the device used to talk to the service has been revoked
- the device no longer belongs to your account

Your tokens are untouched. They live on your account, not the device, and they do not expire.

To use it again, plug it in and pair it like new: the device shows a six-digit code, and you enter that in the dashboard at ${SITE}/signin.

If you did not do this, reply to this email straight away.

- Nishant
Mountain View, California`,
    html: shell(
      h("Your Watima has been reset") +
        p(esc(hi(n))) +
        p(`Device ${b(deviceId)} has been reset and is no longer linked to your account. ${esc(how)}`) +
        p("What that means, precisely:") +
        ul([
          "every question and answer stored for this device has been deleted, not hidden",
          "the credential the device used to talk to the service has been revoked",
          "the device no longer belongs to your account",
        ]) +
        p(`${b("Your tokens are untouched.")} They live on your account, not the device, and they don't expire.`) +
        p(`To use it again, plug it in and pair it like new — the device shows a six-digit code, and you enter that in <a href="${SITE}/signin" style="color:#0F9D6E">the dashboard</a>.`) +
        p(`${b("If you did not do this, reply to this email straight away.")}`) +
        p("— Nishant<br>Mountain View, California"),
    ),
  };
}

module.exports = { fire, welcome, reserved, paired, reset };
