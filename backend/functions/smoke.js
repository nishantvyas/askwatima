"use strict";

/**
 * Exercises the Gemini half of the pipeline without needing the device.
 *
 *   export GEMINI_API_KEY=...
 *   node smoke.js                    # TTS only - writes reply.wav
 *   node smoke.js recording.wav      # full path: audio in -> answer -> reply.wav
 *
 * Record a test clip on macOS with:
 *   ffmpeg -f avfoundation -i ":default" -ar 16000 -ac 1 -t 5 recording.wav
 */

const fs = require("fs");
const { GoogleGenAI, Type } = require("@google/genai");
const { wavFromPcm, resamplePcm16, rmsOf } = require("./audio");

const CHAT_MODEL = process.env.CHAT_MODEL || "gemini-3.6-flash";
const TTS_MODEL = process.env.TTS_MODEL || "gemini-3.1-flash-tts-preview";
const VOICE = process.env.VOICE || "Kore";
const DEVICE_RATE = 16000;
const TTS_RATE = 24000;

/** Strips a WAV header and returns mono PCM16 at the requested rate. */
function pcmFromWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a RIFF/WAV file");

  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (bits !== 16) throw new Error(`need 16-bit PCM, got ${bits}-bit`);

  // Walk the chunk list rather than assuming data starts at byte 44.
  let off = 12;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      data = buf.subarray(off + 8, off + 8 + size);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error("no data chunk");

  if (channels > 1) {
    const frames = Math.floor(data.length / 2 / channels);
    const mono = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) mono.writeInt16LE(data.readInt16LE(i * channels * 2), i * 2);
    data = mono;
  }
  return resamplePcm16(data, rate, DEVICE_RATE);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("set GEMINI_API_KEY first");
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey });
  const inputPath = process.argv[2];

  let answer = "Hello from Watima. Your backend is wired up correctly.";

  if (inputPath) {
    console.log(`reading ${inputPath}`);
    const pcm = pcmFromWav(fs.readFileSync(inputPath));
    console.log(
      `  ${(pcm.length / 2 / DEVICE_RATE).toFixed(2)}s @ ${DEVICE_RATE}Hz, rms ${rmsOf(pcm).toFixed(0)}`,
    );

    const t0 = Date.now();
    const res = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "audio/wav",
                data: wavFromPcm(pcm, DEVICE_RATE).toString("base64"),
              },
            },
            { text: "Transcribe what the user said, then answer them." },
          ],
        },
      ],
      config: {
        systemInstruction:
          "Reply in at most two short sentences. No markdown, no emoji.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcript: { type: Type.STRING },
            answer: { type: Type.STRING },
          },
          required: ["transcript", "answer"],
        },
      },
    });

    const parsed = JSON.parse(res.text);
    console.log(`  heard  : "${parsed.transcript}"  (${Date.now() - t0}ms)`);
    console.log(`  answer : "${parsed.answer}"`);
    answer = parsed.answer;
  }

  const t1 = Date.now();
  const res = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ parts: [{ text: answer }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  });

  const b64 = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error("TTS returned no audio");

  const pcm24 = Buffer.from(b64, "base64");
  const pcm16 = resamplePcm16(pcm24, TTS_RATE, DEVICE_RATE);
  console.log(`  tts    : ${(pcm24.length / 2 / TTS_RATE).toFixed(2)}s  (${Date.now() - t1}ms)`);

  fs.writeFileSync("reply.wav", wavFromPcm(pcm16, DEVICE_RATE));
  fs.writeFileSync("reply.pcm", pcm16);
  console.log("wrote reply.wav (play it) and reply.pcm (what the device receives)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
