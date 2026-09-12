// Does pressing a key actually make the right sound?
//
// Counting bytes would prove nothing - a tone at the wrong frequency is the
// same size as a tone at the right one, and the failure only shows up as a
// phone menu saying "sorry, I can't find that option" on a real call. So this
// decodes the audio back and measures it.

import { dtmfFrames, dtmfDurationMs, cleanDigits, encodeMuLaw, isPressable } from './dtmf.js';
import { TOOLS, runTool } from './tools.js';

let passed = 0;
let failed = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

function checkNear(name, got, want, tol) {
  const ok = Math.abs(got - want) <= tol;
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want} +/- ${tol}`); }
}

// The inverse of the encoder, so we can listen to what we produced.
function decodeMuLaw(byte) {
  const u = (~byte) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

// Goertzel: how much of one exact frequency is present in a block of samples.
function strengthAt(samples, freq, rate = 8000) {
  const k = (2 * Math.cos((2 * Math.PI * freq) / rate));
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / samples.length;
}

const ALL = [697, 770, 852, 941, 1209, 1336, 1477, 1633];

function samplesOf(digits, opts) {
  const buf = Buffer.concat(dtmfFrames(digits, opts).map((b) => Buffer.from(b, 'base64')));
  return Array.from(buf, decodeMuLaw);
}

// The two loudest frequencies in the first part of the tone.
function heardIn(samples) {
  const window = samples.slice(0, 800); // 100ms, safely inside the tone
  const scored = ALL.map((f) => ({ f, v: strengthAt(window, f) }));
  scored.sort((a, b) => b.v - a.v);
  return [scored[0].f, scored[1].f].sort((a, b) => a - b);
}

console.log('\ndtmf');

check('mu-law round trips near zero', Math.abs(decodeMuLaw(encodeMuLaw(0))) < 40, true);
check('mu-law round trips a loud sample', Math.abs(decodeMuLaw(encodeMuLaw(20000)) - 20000) < 700, true);

// Every key on the pad must make its own documented pair.
const EXPECTED = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};
for (const key of Object.keys(EXPECTED)) {
  check(`"${key}" sounds like ${EXPECTED[key].join(' + ')} Hz`, heardIn(samplesOf(key)), EXPECTED[key]);
}

// A zip code is the whole point - five keys, each its own tone, in order.
const zip = '98052';
const frames = dtmfFrames(zip);
check('five keys make the expected length', frames.length, Math.ceil((5 * (180 + 90) * 8) / 160));
check('every frame is a full 20ms frame', frames.every((f) => Buffer.from(f, 'base64').length === 160), true);
checkNear('and the duration is reported honestly', dtmfDurationMs(zip), 5 * 270, 1);

// Read each key back out of the middle of its own slot.
const zipSamples = samplesOf(zip);
const perKey = 270 * 8; // samples per key at 8kHz
const readBack = [];
for (let i = 0; i < 5; i++) {
  const start = i * perKey;
  readBack.push(heardIn(zipSamples.slice(start, start + perKey)));
}
check('98052 comes back as 9, 8, 0, 5, 2', readBack, [
  EXPECTED['9'], EXPECTED['8'], EXPECTED['0'], EXPECTED['5'], EXPECTED['2'],
]);

// The gap is what makes "00" two presses instead of one long one.
const doubleZero = samplesOf('00');
const gapWindow = doubleZero.slice(180 * 8 + 80, 270 * 8 - 80);
const loudestInGap = Math.max(...ALL.map((f) => strengthAt(gapWindow, f)));
const loudestInTone = Math.max(...ALL.map((f) => strengthAt(doubleZero.slice(0, 800), f)));
check('there is real silence between two presses', loudestInGap < loudestInTone / 20, true);

// Nothing that is not on a telephone keypad should ever reach the line.
check('letters are dropped', cleanDigits('9k8').digits, '98');
check('and reported, not silently swallowed', cleanDigits('9k8').dropped, ['k']);
check('spaces and dashes are fine', cleanDigits('425-555 1234').digits, '4255551234');
check('star and hash are real keys', cleanDigits('*0#').digits, '*0#');
check('nothing pressable means no audio at all', dtmfFrames('hello').length, 0);
check('a keypad has no letter k', isPressable('k'), false);
check('but it does have a zero', isPressable('0'), true);

// --- the tools the model actually calls -------------------------------------

console.log('\nkeypad and hold, through the tool layer');

const fakeFindings = { keysPressed: [], notePressedKeys(d, w) { this.keysPressed.push({ d, w }); return { ok: true }; } };
let sent = null;
let held = null;
const hooks = {
  onPressKeys: (d, w) => { sent = { d, w }; },
  onHold: (s, w) => { held = { s, w }; },
};

let r = runTool(fakeFindings, 'press_keys', { digits: '98052', why: 'it asked for a zip' }, hooks);
check('pressing a zip is allowed', r.ok, true);
check('and reaches the line', sent.d, '98052');
check('and is written down', fakeFindings.keysPressed[0].d, '98052');

sent = null;
r = runTool(fakeFindings, 'press_keys', { digits: 'hello' }, hooks);
check('a word is not a keypress', r.ok, false);
check('and nothing goes down the line', sent, null);

r = runTool(fakeFindings, 'press_keys', { digits: '425-555-1234' }, hooks);
check('punctuation in a number is fine', sent.d, '4255551234');

sent = null;
r = runTool(fakeFindings, 'press_keys', { digits: '1'.repeat(21) }, hooks);
check('hammering the menu is refused', r.ok, false);
check('and nothing is sent', sent, null);

r = runTool(fakeFindings, 'press_keys', { digits: '9k8' }, hooks);
check('a stray letter does not silently vanish', r.note.indexOf('could not be pressed') > -1, true);

r = runTool(fakeFindings, 'wait_on_hold', { seconds: 45, why: 'transferring me' }, hooks);
check('holding is allowed', r.ok, true);
check('for the time asked', held.s, 45);

runTool(fakeFindings, 'wait_on_hold', { seconds: 9999 }, hooks);
check('but not forever', held.s, 120);

runTool(fakeFindings, 'wait_on_hold', { seconds: 1 }, hooks);
check('and not for a pointless instant', held.s, 10);

runTool(fakeFindings, 'wait_on_hold', { seconds: 'a while' }, hooks);
check('nonsense falls back to a sensible wait', held.s, 60);

const names = TOOLS.map(function (t) { return t.name; });
check('the model is offered the keypad', names.indexOf('press_keys') > -1, true);
check('and the hold button', names.indexOf('wait_on_hold') > -1, true);

// A menu must no longer be a reason to hang up.
const kinds = TOOLS.find(function (t) { return t.name === 'note_bad_pickup'; }).parameters.properties.kind.enum;
check('a phone tree is no longer a bad pickup', kinds.indexOf('phone_tree'), -1);
check('nor is hold music', kinds.indexOf('hold_music'), -1);
check('voicemail still is', kinds.indexOf('voicemail') > -1, true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
