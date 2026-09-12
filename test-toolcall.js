// Tests for the tool plumbing in realtime.js.
//
// No socket, no Azure. A fake ws captures what we would have sent, and fake
// events are fed straight into onAzureEvent. This covers the ordering rule
// that is easy to get wrong: the answer to a tool call goes out immediately,
// but the request for a new reply must wait until the current response is
// finished, because Azure allows only one at a time.

import { Realtime } from './realtime.js';
import { Findings } from './findings.js';
import { TOOLS, runTool } from './tools.js';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? '  <- ' + detail : ''}`);
  }
}

const job = {
  client: 'Yihan Sun',
  zip: '98053',
  windows: [{ day: 'thu', startMin: 780, endMin: 900 }],
};

function harness() {
  const sent = [];
  const findings = new Findings(job);
  let ended = null;
  const rt = new Realtime({
    tools: TOOLS,
    greetingDelayMs: 0,
    onToolCall: (name, args) => runTool(findings, name, args, { onEndCall: (r) => (ended = r) }),
  });
  rt.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  rt.ready = true;
  return { rt, sent, findings, ended: () => ended };
}

function toolCall(rt, name, args, callId = 'call_1') {
  rt.onAzureEvent({ type: 'response.created', response: { id: 'resp_1' } });
  rt.onAzureEvent({ type: 'response.function_call_arguments.done', name, call_id: callId, arguments: JSON.stringify(args) });
}

console.log('\nanswering a tool call');
{
  const { rt, sent, findings } = harness();
  toolCall(rt, 'note_callout', { feeUsd: 95, waivedIfRepaired: true });

  const out = sent.find((m) => m.type === 'conversation.item.create');
  ok('the result is handed straight back', !!out);
  ok('...as a function_call_output', out?.item?.type === 'function_call_output');
  ok('...against the right call_id', out?.item?.call_id === 'call_1');
  ok('...carrying the result as JSON', JSON.parse(out.item.output).ok === true);
  ok('the value actually landed on the notepad', findings.callout.feeUsd === 95);
  ok('no new response is asked for yet', !sent.some((m) => m.type === 'response.create'));

  rt.onAzureEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
}

console.log('\nasking for the follow-up reply');
{
  const { rt, sent } = harness();
  toolCall(rt, 'note_quote', { lowUsd: 200 });
  rt.onAzureEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
  // The follow-up is deferred by a tick so it can never land inside response.done.
  await new Promise((r) => setTimeout(r, 10));
  ok('a new reply is requested once the response finishes', sent.some((m) => m.type === 'response.create'));
  ok('...exactly once', sent.filter((m) => m.type === 'response.create').length === 1);
}

console.log('\nnot answering twice when she has already spoken');
{
  // The bug this replaces: a note went in cleanly, she had already said her
  // piece in that same response, and we asked for another reply anyway - so
  // she talked over herself 0.4s after finishing.
  const { rt, sent } = harness();
  rt.onAzureEvent({ type: 'response.created', response: { id: 'resp_1' } });
  rt.onAzureEvent({ type: 'response.output_audio.delta', delta: 'AAAA' });
  rt.onAzureEvent({
    type: 'response.function_call_arguments.done',
    name: 'note_callout',
    call_id: 'call_1',
    arguments: JSON.stringify({ feeUsd: 60, waivedIfRepaired: true }),
  });
  rt.onAzureEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  ok('she spoke and the note went in - no second reply is forced', !sent.some((m) => m.type === 'response.create'));
}

console.log('\nstill speaking up when the result is news');
{
  // A refused slot is news: she has to tell them it does not work. She gets a
  // reply even though she already spoke.
  const { rt, sent } = harness();
  rt.onAzureEvent({ type: 'response.created', response: { id: 'resp_1' } });
  rt.onAzureEvent({ type: 'response.output_audio.delta', delta: 'AAAA' });
  rt.onAzureEvent({
    type: 'response.function_call_arguments.done',
    name: 'note_time_slot',
    call_id: 'call_2',
    arguments: JSON.stringify({ day: 'thu', startTime: '09:00', endTime: '10:00' }),
  });
  rt.onAzureEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  ok('a refused note still gets said out loud', sent.some((m) => m.type === 'response.create'));
}

console.log('\nstill speaking up when she wrote without talking');
{
  // A silent tool call would otherwise leave dead air on the line.
  const { rt, sent } = harness();
  toolCall(rt, 'note_visit_duration', { minMinutes: 30 });
  rt.onAzureEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  ok('a note written in silence still gets a reply', sent.some((m) => m.type === 'response.create'));
}

console.log('\nnot starting a new turn once the call is ending');
{
  const { rt, sent } = harness();
  rt.onAzureEvent({ type: 'response.created', response: { id: 'resp_1' } });
  rt.onAzureEvent({ type: 'response.output_audio.delta', delta: 'AAAA' });
  rt.onAzureEvent({
    type: 'response.function_call_arguments.done',
    name: 'end_call',
    call_id: 'call_3',
    arguments: JSON.stringify({ reason: 'said_goodbye' }),
  });
  rt.onAzureEvent({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  ok('ending the call does not trigger one more thing to say', !sent.some((m) => m.type === 'response.create'));
}

console.log('\na turn that could not be transcribed is still written down');
{
  const heard = [];
  const rt = new Realtime({ tools: TOOLS, onToolCall: () => ({ ok: true }), onCallerTranscript: (t) => heard.push(t) });
  rt.ws = { readyState: 1, send: () => {} };
  rt.ready = true;
  rt.onAzureEvent({
    type: 'conversation.item.input_audio_transcription.failed',
    error: { message: 'audio too short' },
  });
  ok('a failed transcription reaches the transcript as a blank turn', heard.length === 1 && heard[0] === '');
}

console.log('\nbarge-in during a tool call');
{
  const { rt, sent } = harness();
  let bargedIn = false;
  rt.onBargeIn = () => (bargedIn = true);
  toolCall(rt, 'note_quote', { lowUsd: 200 });
  rt.onAzureEvent({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled' } });
  await new Promise((r) => setTimeout(r, 10));
  ok('the caller interrupting still drops the buffer', bargedIn);
  // They are mid-sentence. Semantic VAD will start the next reply itself, so
  // asking for one here would have her talking over them.
  ok('no reply is forced while they are talking', !sent.some((m) => m.type === 'response.create'));
}

console.log('\na refused tool');
{
  const { rt, sent } = harness();
  toolCall(rt, 'note_time_slot', { day: 'thu', startTime: '09:00', endTime: '10:00' });
  const out = sent.find((m) => m.type === 'conversation.item.create');
  const result = JSON.parse(out.item.output);
  ok('the refusal goes back to the model', result.ok === false);
  ok('...with a reason she can say out loud', typeof result.error === 'string' && result.error.length > 20, result.error);
}

console.log('\nbad input from the model');
{
  const { rt, sent } = harness();
  rt.onAzureEvent({ type: 'response.created', response: { id: 'resp_1' } });
  rt.onAzureEvent({ type: 'response.function_call_arguments.done', name: 'note_quote', call_id: 'c1', arguments: '{not json' });
  const out = sent.find((m) => m.type === 'conversation.item.create');
  ok('broken JSON does not crash the call', !!out);
  ok('...it comes back as a refusal she can retry', JSON.parse(out.item.output).ok === false);

  const h2 = harness();
  h2.rt.onAzureEvent({ type: 'response.created', response: { id: 'r' } });
  h2.rt.onAzureEvent({ type: 'response.function_call_arguments.done', name: 'note_quote', arguments: '{}' });
  ok('a tool call with no call_id is dropped, not answered blindly', !h2.sent.some((m) => m.type === 'conversation.item.create'));
}

console.log('\nend_call');
{
  const h = harness();
  toolCall(h.rt, 'end_call', { reason: 'said_goodbye' });
  ok('the server is told to hang up', h.ended() === 'said_goodbye');
  ok('the line is not dropped by the tool itself', h.findings.hangup !== null);
}

console.log('\nthe caller transcript reaches the notepad');
{
  const sent = [];
  const findings = new Findings(job);
  const rt = new Realtime({
    tools: TOOLS,
    onToolCall: (name, args) => runTool(findings, name, args),
    onCallerTranscript: (text) => findings.noteCallerTurn(text),
  });
  rt.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  rt.ready = true;

  // Exactly what happened on the real call: a blank transcript, then the model
  // deciding that silence meant "no".
  rt.onAzureEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' });
  rt.onAzureEvent({ type: 'response.created', response: { id: 'r1' } });
  rt.onAzureEvent({
    type: 'response.function_call_arguments.done',
    name: 'note_service_area',
    call_id: 'c1',
    arguments: JSON.stringify({ covers: false, theirWords: 'Okay' }),
  });
  const out = JSON.parse(sent.find((m) => m.type === 'conversation.item.create').item.output);
  ok('a blank transcript blocks the call-ending verdict end to end', out.ok === false, JSON.stringify(out));

  rt.onAzureEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'No, we stay in Seattle.' });
  ok('a real answer gets through', findings.heardSomething() === true);
  ok('...and turns are counted', findings.callerTurns === 1);
}

console.log('\nthe session Azure is given');
{
  const { rt, sent } = harness();
  rt.ready = false;
  rt.onAzureEvent({ type: 'session.created', session: { id: 's' } });
  // #sendSession is private, so drive it the way connect() does.
  rt.ws.send = (s) => sent.push(JSON.parse(s));
  const before = sent.length;
  rt.speakFirst('say hi');
  rt.onAzureEvent({ type: 'session.updated' });
  ok('the greeting waits for the session to be ready', sent.length > before);
  ok('...and asks for a response', sent.some((m) => m.type === 'response.create'));
}

console.log('\nthe greeting still survives being cut off');
{
  const { rt, sent } = harness();
  rt.speakFirst('say hi and disclose');
  rt.onAzureEvent({ type: 'response.created', response: { id: 'g1' } });
  // Line noise trips the VAD before a single frame of audio is out.
  rt.onAzureEvent({ type: 'response.done', response: { id: 'g1', status: 'cancelled' } });
  await new Promise((r) => setTimeout(r, 500));
  ok('a greeting killed before any audio is said again', sent.filter((m) => m.type === 'response.create').length >= 2);

  // A tool-only turn produces no audio either, but it completed rather than
  // being cancelled, so it must not be mistaken for a lost greeting.
  const h2 = harness();
  h2.rt.speakFirst('say hi');
  h2.rt.onAzureEvent({ type: 'response.created', response: { id: 'g1' } });
  h2.rt.onAzureEvent({ type: 'response.done', response: { id: 'g1', status: 'completed' } });
  await new Promise((r) => setTimeout(r, 500));
  ok('a silent but completed turn is not retried as a greeting', h2.sent.filter((m) => m.type === 'response.create').length === 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
