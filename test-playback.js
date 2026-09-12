// Proves the playback ledger reports what the caller heard, not what the
// model generated. Pure arithmetic - no sockets, no phone call.

import { Playback, b64Bytes } from './playback.js';

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
}

// 8000 bytes/sec mu-law, so 8 bytes per ms. 800 bytes = 100ms of audio.
const chunk100ms = Buffer.alloc(800).toString('base64');

console.log('\nbase64 length maths:');
check('800 bytes decodes to 800', b64Bytes(chunk100ms), 800);
check('padded string handled', b64Bytes(Buffer.alloc(802).toString('base64')), 802);

console.log('\nheard in full:');
{
  const settled = [];
  const p = new Playback({ onSettled: (r) => settled.push(r) });
  p.startResponse('r1');
  const marks = [p.queue(chunk100ms, 'r1'), p.queue(chunk100ms, 'r1')];
  p.endResponse('r1', 'hello there', 'completed');
  check('nothing settles before playback', settled.length, 0);
  marks.forEach((m) => p.confirmMark(m));
  check('settles once played', settled.length, 1);
  check('reported as fully heard', Math.round(settled[0].heardFraction * 100), 100);
}

console.log('\ncut off halfway - the bug we saw on the real call:');
{
  const settled = [];
  const p = new Playback({ onSettled: (r) => settled.push(r) });
  p.startResponse('r1');
  const m1 = p.queue(chunk100ms, 'r1');
  p.queue(chunk100ms, 'r1');
  p.queue(chunk100ms, 'r1');
  p.queue(chunk100ms, 'r1'); // 400ms generated
  p.confirmMark(m1);         // only the first 100ms actually played
  p.endResponse('r1', 'a long sentence nobody finished hearing', 'cancelled');
  const dropped = p.clear(); // caller interrupted, Twilio bins the rest
  check('300ms dropped', Math.round(dropped), 300);
  check('one row settled', settled.length, 1);
  check('reported 25% heard', Math.round(settled[0].heardFraction * 100), 25);
  check('heardMs is 100', Math.round(settled[0].heardMs), 100);
}

console.log('\ngenerated but never played at all:');
{
  const settled = [];
  const p = new Playback({ onSettled: (r) => settled.push(r) });
  p.startResponse('r1');
  p.queue(chunk100ms, 'r1');
  p.endResponse('r1', 'said into the void', 'cancelled');
  p.clear();
  check('reported 0% heard', Math.round(settled[0].heardFraction * 100), 0);
}

console.log('\nbacklog tracks how far behind the caller is:');
{
  const p = new Playback();
  p.startResponse('r1');
  const m1 = p.queue(chunk100ms, 'r1');
  p.queue(chunk100ms, 'r1');
  p.queue(chunk100ms, 'r1');
  check('300ms queued, none played', Math.round(p.backlogMs), 300);
  p.confirmMark(m1);
  check('200ms still buffered', Math.round(p.backlogMs), 200);
}

console.log('\ntwo responses back to back stay separate:');
{
  const settled = [];
  const p = new Playback({ onSettled: (r) => settled.push(r) });
  p.startResponse('r1');
  const a = p.queue(chunk100ms, 'r1');
  p.endResponse('r1', 'first', 'completed');
  p.startResponse('r2');
  const b = p.queue(chunk100ms, 'r2');
  p.endResponse('r2', 'second', 'completed');
  p.confirmMark(a);
  p.confirmMark(b);
  check('both settled', settled.length, 2);
  check('first is first', settled[0].text, 'first');
  check('each fully heard', settled.every((r) => r.heardFraction > 0.99), true);
}

console.log('');
console.log(failures ? `${failures} FAILED` : 'all playback tests passed');
process.exit(failures ? 1 : 0);
