// Pressing buttons on a phone.
//
// Half the companies we ring do not answer with a person. They answer with a
// menu - "enter your zip code", "press 0 for a representative" - and until now
// the agent had no way to do anything about it, so it hung up on lines that
// were perfectly willing to talk. Six calls in one evening.
//
// Twilio's media stream has no "send a digit" message, so we do what a real
// telephone does: play the tone. A DTMF key is two sine waves added together,
// one from its row and one from its column, and every phone system on earth
// knows how to hear that. The audio goes out through the same pipe as speech.
//
// All of this is arithmetic. Nothing in here reads or interprets anything
// anybody said - the model decides which keys to press, and this turns that
// decision into sound.

const RATE = 8000;          // mu-law, 8 kHz, mono - what Twilio speaks
const FRAME_BYTES = 160;    // 20 ms per frame, same as every other frame we send
const AMPLITUDE = 0.28;     // per tone, so the pair together cannot clip

// The standard touch-tone grid. Row frequency plus column frequency.
const ROWS = [697, 770, 852, 941];
const COLS = [1209, 1336, 1477, 1633];
const KEYS = [
  ['1', '2', '3', 'A'],
  ['4', '5', '6', 'B'],
  ['7', '8', '9', 'C'],
  ['*', '0', '#', 'D'],
];

const TONES = new Map();
for (let r = 0; r < KEYS.length; r++) {
  for (let c = 0; c < KEYS[r].length; c++) {
    TONES.set(KEYS[r][c], [ROWS[r], COLS[c]]);
  }
}

export function isPressable(ch) {
  return TONES.has(String(ch).toUpperCase());
}

// Keep only keys a telephone actually has. A menu cannot be sent the letter
// "k", and a digit string that quietly lost half its characters would dial
// into the wrong part of the menu without anyone noticing.
export function cleanDigits(input) {
  const kept = [];
  const dropped = [];
  for (const ch of String(input ?? '')) {
    if (ch === ' ' || ch === '-' || ch === '(' || ch === ')' || ch === '+') continue;
    const up = ch.toUpperCase();
    if (TONES.has(up)) kept.push(up);
    else dropped.push(ch);
  }
  return { digits: kept.join(''), dropped };
}

// G.711 mu-law. Takes a 16 bit signed sample, returns one byte.
export function encodeMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  let sign = 0;
  if (s < 0) { sign = 0x80; s = -s; }
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) { /* find the top bit */ }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

// Raw mu-law bytes for one key, followed by the silence after it. Both halves
// matter: a menu that never hears a gap hears one long press, not two keys.
function keyBytes(key, toneMs, gapMs, phase = { v: 0 }) {
  const pair = TONES.get(key);
  const toneSamples = Math.round((RATE * toneMs) / 1000);
  const gapSamples = Math.round((RATE * gapMs) / 1000);
  const out = Buffer.alloc(toneSamples + gapSamples);

  for (let i = 0; i < toneSamples; i++) {
    const t = (phase.v + i) / RATE;
    const v = Math.sin(2 * Math.PI * pair[0] * t) + Math.sin(2 * Math.PI * pair[1] * t);
    out[i] = encodeMuLaw(v * AMPLITUDE * 32767);
  }
  // Mu-law silence is 0xFF, not 0x00 - zero is a loud sample, and a run of it
  // is a buzz rather than a gap.
  out.fill(0xff, toneSamples);
  phase.v += toneSamples + gapSamples;
  return out;
}

// Everything needed to press a sequence of keys, cut into the 20 ms frames
// Twilio expects. Returns base64 payloads, ready to send.
export function dtmfFrames(digits, { toneMs = 180, gapMs = 90 } = {}) {
  const { digits: clean } = cleanDigits(digits);
  if (!clean) return [];

  const phase = { v: 0 };
  const parts = [];
  for (const key of clean) parts.push(keyBytes(key, toneMs, gapMs, phase));
  const all = Buffer.concat(parts);

  const frames = [];
  for (let i = 0; i < all.length; i += FRAME_BYTES) {
    const slice = all.subarray(i, i + FRAME_BYTES);
    // Twilio wants whole frames; pad the tail with silence rather than sending
    // a short one.
    if (slice.length === FRAME_BYTES) {
      frames.push(slice.toString('base64'));
    } else {
      const padded = Buffer.alloc(FRAME_BYTES, 0xff);
      slice.copy(padded);
      frames.push(padded.toString('base64'));
    }
  }
  return frames;
}

// How long the whole press will take to play, so the caller can be kept quiet
// for exactly that long and not a second more.
export function dtmfDurationMs(digits, { toneMs = 180, gapMs = 90 } = {}) {
  const { digits: clean } = cleanDigits(digits);
  return clean.length * (toneMs + gapMs);
}

export const DTMF_RATE = RATE;
export const DTMF_FRAME_BYTES = FRAME_BYTES;
