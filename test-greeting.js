// Proves the greeting retry without spending a phone call.
//
// The greeting carries the AI disclosure, so "it got cancelled by line noise
// and nobody noticed" is the one failure that actually matters here. This
// drives Realtime with fake Azure events and checks it says it again.

import { Realtime } from './realtime.js';
import * as log from './log.js';

let failures = 0;

function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
}

// Stands in for the Azure socket: records what we send, never opens anything.
function harness() {
  const rt = new Realtime({ instructions: 'test' });
  const sent = [];
  rt.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  rt.ready = true;
  const feed = (ev) => rt.onAzureEvent(ev);
  const greetings = () => sent.filter((m) => m.type === 'response.create').length;
  return { rt, sent, feed, greetings };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\ngreeting cancelled by line noise, no audio produced:');
{
  const { rt, feed, greetings } = harness();
  rt.speakFirst('say hi and disclose');
  check('greeting sent once', greetings(), 1);

  feed({ type: 'response.created', response: { id: 'resp_1' } });
  feed({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled' } });
  await wait(600);
  check('greeting retried', greetings(), 2);

  // Second attempt gets audio out, so it counts as delivered.
  feed({ type: 'response.created', response: { id: 'resp_2' } });
  feed({ type: 'response.output_audio.delta', delta: 'AAAA' });
  feed({ type: 'response.done', response: { id: 'resp_2', status: 'completed' } });
  await wait(600);
  check('no further retry once delivered', greetings(), 2);
}

console.log('\ngreeting cancelled AFTER audio started (real interruption):');
{
  const { rt, feed, greetings } = harness();
  rt.speakFirst('say hi and disclose');
  feed({ type: 'response.created', response: { id: 'resp_1' } });
  feed({ type: 'response.output_audio.delta', delta: 'AAAA' });
  feed({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled' } });
  await wait(600);
  // They heard it and cut in on purpose. Repeating it would be obnoxious.
  check('not repeated over a real interruption', greetings(), 1);
}

console.log('\nsomeone else\'s response gets cancelled:');
{
  const { rt, feed, greetings } = harness();
  rt.speakFirst('say hi and disclose');
  feed({ type: 'response.created', response: { id: 'resp_greeting' } });
  feed({ type: 'response.output_audio.delta', delta: 'AAAA' });
  feed({ type: 'response.done', response: { id: 'resp_greeting', status: 'completed' } });
  await wait(100);
  // A later turn is cancelled - must not be mistaken for the greeting.
  feed({ type: 'response.created', response: { id: 'resp_later' } });
  feed({ type: 'response.done', response: { id: 'resp_later', status: 'cancelled' } });
  await wait(600);
  check('unrelated cancel ignored', greetings(), 1);
}

console.log('\ngreeting cancelled over and over:');
{
  const { rt, feed, greetings } = harness();
  rt.speakFirst('say hi and disclose');
  for (const id of ['a', 'b', 'c', 'd']) {
    feed({ type: 'response.created', response: { id } });
    feed({ type: 'response.done', response: { id, status: 'cancelled' } });
    await wait(600);
  }
  check('gives up after 3 total attempts', greetings(), 3);
}

console.log('');
console.log(failures ? `${failures} FAILED` : 'all greeting tests passed');
process.exit(failures ? 1 : 0);
