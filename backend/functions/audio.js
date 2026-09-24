"use strict";

/**
 * PCM helpers shared by the function and the smoke test.
 *
 * The device records 16 kHz mono 16-bit LE and can only play back at the same
 * rate (its mic and speaker codecs share one I2S clock), while Gemini TTS
 * always returns 24 kHz. Everything here exists to bridge those two facts.
 */

/** Wraps raw PCM16 in a 44-byte WAV header so Gemini accepts it as audio/wav. */
function wavFromPcm(pcm, sampleRate, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Resamples mono PCM16 with linear interpolation.
 *
 * Going 24k -> 16k drops Nyquist from 12 kHz to 8 kHz, so anything above 8 kHz
 * would fold back as aliasing. A short moving-average pre-filter knocks that
 * band down first. It is not a brickwall filter, but for speech played through
 * a 16 mm speaker it is well past the point of audibility.
 */
function resamplePcm16(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;

  const inCount = Math.floor(pcm.length / 2);
  const input = new Int16Array(inCount);
  for (let i = 0; i < inCount; i++) input[i] = pcm.readInt16LE(i * 2);

  let src = input;
  if (toRate < fromRate) {
    const filtered = new Int16Array(inCount);
    for (let i = 0; i < inCount; i++) {
      const a = input[i - 1] !== undefined ? input[i - 1] : input[i];
      const b = input[i];
      const c = input[i + 1] !== undefined ? input[i + 1] : input[i];
      filtered[i] = (a + 2 * b + c) >> 2;
    }
    src = filtered;
  }

  const ratio = fromRate / toRate;
  const outCount = Math.floor(inCount / ratio);
  const out = Buffer.alloc(outCount * 2);

  for (let i = 0; i < outCount; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = src[idx];
    const s1 = idx + 1 < inCount ? src[idx + 1] : s0;
    let v = Math.round(s0 + (s1 - s0) * frac);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

/**
 * Streaming form of resamplePcm16, for audio that arrives in pieces.
 *
 * Resampling each chunk independently and concatenating does NOT work. Both
 * stages of the algorithm reach across sample boundaries - the anti-alias filter
 * reads i-1 and i+1, and the interpolator reads idx and idx+1 - so a chunk
 * processed alone invents edge values at both ends, and the output clicks at
 * every seam. The unary path gets away with concatenation only because each TTS
 * response starts and ends in silence; a mid-word chunk boundary does not.
 *
 * So this keeps two pieces of state between pushes: the unconsumed input tail
 * (plus one sample of left context for the filter) and the fractional read
 * position, which almost never lands on a sample boundary at a 3:2 ratio.
 *
 * Output is sample-for-sample identical to resamplePcm16 over the same total
 * input, regardless of how the input happens to be split.
 */
function createResampler(fromRate, toRate) {
  if (fromRate === toRate) {
    return { push: (b) => b, flush: () => Buffer.alloc(0) };
  }

  const ratio = fromRate / toRate;
  const down = toRate < fromRate;
  let pend = new Int16Array(0); // input samples not yet fully consumed
  let pos = 0;                  // fractional read position within `pend`

  const filt = (i) => {
    if (!down) return pend[i];
    const a = i > 0 ? pend[i - 1] : pend[i];
    const b = pend[i];
    const c = i + 1 < pend.length ? pend[i + 1] : pend[i];
    return (a + 2 * b + c) >> 2;
  };

  function run(final) {
    const out = [];
    for (;;) {
      const idx = Math.floor(pos);
      // Interpolating at idx needs filt(idx+1), which itself reads idx+2. Until
      // the stream ends we must wait for that sample rather than fabricate it.
      const need = final ? idx + 1 : idx + 2;
      if (need > pend.length - 1) break;

      const frac = pos - idx;
      const s0 = filt(idx);
      const s1 = idx + 1 <= pend.length - 1 ? filt(idx + 1) : s0;
      let v = Math.round(s0 + (s1 - s0) * frac);
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      out.push(v);
      pos += ratio;
    }

    // Retain one sample before the read head so the filter keeps its left context.
    const keep = Math.max(0, Math.floor(pos) - 1);
    if (keep > 0) {
      pend = pend.slice(keep);
      pos -= keep;
    }

    const buf = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) buf.writeInt16LE(out[i], i * 2);
    return buf;
  }

  return {
    push(chunk) {
      const n = Math.floor(chunk.length / 2);
      const merged = new Int16Array(pend.length + n);
      merged.set(pend);
      for (let i = 0; i < n; i++) merged[pend.length + i] = chunk.readInt16LE(i * 2);
      pend = merged;
      return run(false);
    },
    /** Drains the tail; call once when the stream ends. */
    flush() {
      return run(true);
    },
  };
}

/**
 * Trims an answer to a hard ceiling, preferring to end on a sentence boundary
 * so the reply never stops mid-thought. TTS time scales with length, so this is
 * the backstop that bounds how long the device can possibly be left talking.
 */
function capAnswer(text, maxChars) {
  const t = (text || "").trim();
  if (t.length <= maxChars) return t;

  const cut = t.slice(0, maxChars);
  const lastEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  // Only honour a sentence break if it keeps a useful amount of the answer.
  if (lastEnd > maxChars * 0.4) return cut.slice(0, lastEnd + 1).trim();
  return cut.replace(/[\s,;:]+\S*$/, "").trim() + ".";
}

/**
 * Splits an answer into chunks for incremental speech synthesis.
 *
 * Sentence boundaries, not fixed durations: speech runs about 2.3 words per
 * second, so a 3-second slice is only ~7 words and would cut mid-sentence,
 * which wrecks TTS prosody. Whole sentences land at 3-6s naturally.
 *
 * The first sentence is deliberately left to stand alone whenever it is long
 * enough to be worth a call: it is the one that decides how soon the device can
 * start speaking, so merging it into its neighbour directly costs time-to-first
 * -audio. Later fragments do get glued together, since by then we are only
 * avoiding needless round trips.
 */
function splitForSpeech(text, minChunkChars = 45, firstMinChars = 20) {
  const parts = (text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [text]).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const prev = out.length ? out[out.length - 1] : null;
    const floor = out.length === 1 ? firstMinChars : minChunkChars;
    if (prev !== null && prev.length < floor) {
      out[out.length - 1] += " " + p;
    } else {
      out.push(p);
    }
  }
  return out.length ? out : [text];
}

/** Rough loudness check so we can reject silence before paying for a model call. */
function rmsOf(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

module.exports = {
  wavFromPcm, resamplePcm16, createResampler, rmsOf, capAnswer, splitForSpeech,
};
