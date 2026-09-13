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
  const rt = new Realtime({ instructions: 'test', greetingDelayMs: 0 });
  const sent = [];
  rt.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  rt.ready = true;
  const feed = (ev) => rt.onAzureEvent(ev);
  const greetings = () => sent.filter((m) => m.type === 'response.create').length;
  return { rt, sent, feed, greetings };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nshe lets them say who they are first:');
{
  // A business answers with a sentence - "Appliance Repair, this is Dave".
  // Opening her mouth the instant the line connects talks straight over it.
  const rt = new Realtime({ instructions: 'test', greetingDelayMs: 120 });
  const sent = [];
  rt.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  rt.ready = true;
  const greetings = () => sent.filter((m) => m.type === 'response.create').length;

  rt.speakFirst('say hi and disclose');
  check('nothing said the moment the line opens', greetings(), 0);
  await wait(60);
  check('...still holding halfway through the pause', greetings(), 0);
  await wait(150);
  check('...then she introduces herself', greetings(), 1);
}

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

console.log('\nshe does not cut in while they are still talking:');
{
  // The bug: the pause was a plain timer, so whatever you were saying at the
  // 2s mark got talked over. Now the timer is a minimum, not a deadline.
  const rt = new Realtime({ instructions: 'test', greetingDelayMs: 100 });
  const sent = [];
  rt.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  rt.ready = true;
  const greetings = () => sent.filter((m) => m.type === 'response.create').length;

  rt.speakFirst('say hi and disclose');
  rt.onAzureEvent({ type: 'input_audio_buffer.speech_started' });
  await wait(250);
  check('holds while they are mid-sentence', greetings(), 0);

  rt.onAzureEvent({ type: 'input_audio_buffer.speech_stopped' });
  // VAD does not open a turn of its own, so she has to.
  await wait(1400);
  check('...then greets once they pause', greetings(), 1);
}

console.log('\nshe does not say hello twice:');
{
  // Semantic VAD makes its own reply when a turn ends. If we also asked for
  // one, that is two greetings on top of each other.
  const rt = new Realtime({ instructions: 'test', greetingDelayMs: 100 });
  const sent = [];
  rt.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  rt.ready = true;
  const greetings = () => sent.filter((m) => m.type === 'response.create').length;

  rt.speakFirst('say hi and disclose');
  rt.onAzureEvent({ type: 'input_audio_buffer.speech_started' });
  await wait(250);
  rt.onAzureEvent({ type: 'input_audio_buffer.speech_stopped' });
  rt.onAzureEvent({ type: 'response.created', response: { id: 'vad_1' } });
  await wait(1400);
  check('the turn VAD opened is used as the greeting', greetings(), 0);

  rt.onAzureEvent({ type: 'response.output_audio.delta', delta: 'AAAA' });
  rt.onAzureEvent({ type: 'response.done', response: { id: 'vad_1', status: 'completed' } });
  await wait(200);
  check('...and it counts as delivered', rt.greetingPending, false);
}

console.log('\na second breath does not trigger her either:');
{
  const rt = new Realtime({ instructions: 'test', greetingDelayMs: 100 });
  const sent = [];
  rt.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  rt.ready = true;
  const greetings = () => sent.filter((m) => m.type === 'response.create').length;

  rt.speakFirst('say hi and disclose');
  rt.onAzureEvent({ type: 'input_audio_buffer.speech_started' });
  await wait(200);
  rt.onAzureEvent({ type: 'input_audio_buffer.speech_stopped' });
  // They pause for breath and carry straight on.
  await wait(200);
  rt.onAzureEvent({ type: 'input_audio_buffer.speech_started' });
  await wait(1400);
  check('still holding while they carry on', greetings(), 0);

  rt.onAzureEvent({ type: 'input_audio_buffer.speech_stopped' });
  await wait(1400);
  check('...greets when they are actually done', greetings(), 1);
}

console.log('\na line that never goes quiet still hears the disclosure:');
{
  const rt = new Realtime({ instructions: 'test', greetingDelayMs: 100, greetingMaxWaitMs: 300 });
  const sent = [];
  rt.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  rt.ready = true;
  const greetings = () => sent.filter((m) => m.type === 'response.create').length;

  rt.speakFirst('say hi and disclose');
  rt.onAzureEvent({ type: 'input_audio_buffer.speech_started' });
  await wait(500);
  // Past the ceiling now, so the next pause check gives up waiting.
  rt.onAzureEvent({ type: 'input_audio_buffer.speech_stopped' });
  await wait(1400);
  check('disclosure is not lost to a noisy line', greetings(), 1);
}

console.log('');
console.log(failures ? `${failures} FAILED` : 'all greeting tests passed');
process.exit(failures ? 1 : 0);
