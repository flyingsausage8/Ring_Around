// Tests for the notepad: what gets recorded, and what gets refused.
//
// These run without a phone, a tunnel or Azure. Every check here is a bug that
// would otherwise only show up mid-call, in front of a real contractor.

import fs from 'node:fs';
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

// The real job's availability, as parsed from JOB_AVAILABILITY_WINDOWS.
const job = {
  client: 'Yihan Sun',
  zip: '98053',
  area: 'Redmond, WA',
  issue: 'cooktop is dead',
  budgetLow: 300,
  budgetHigh: 400,
  windows: [
    { day: 'mon', startMin: 780, endMin: 900 }, { day: 'mon', startMin: 1020, endMin: 1200 },
    { day: 'tue', startMin: 780, endMin: 900 }, { day: 'tue', startMin: 1020, endMin: 1200 },
    { day: 'wed', startMin: 780, endMin: 900 }, { day: 'wed', startMin: 1020, endMin: 1200 },
    { day: 'thu', startMin: 780, endMin: 900 }, { day: 'thu', startMin: 1020, endMin: 1200 },
    { day: 'fri', startMin: 780, endMin: 900 }, { day: 'fri', startMin: 1020, endMin: 1200 },
    { day: 'sat', startMin: 600, endMin: 1439 },
  ],
};

const f = () => new Findings(job);

console.log('\ntime slots');

// The one that went wrong on a real call: Mia refused Thursday 1-2pm, which
// sits squarely inside the 13:00-15:00 window. Nothing may refuse it.
{
  const r = f().noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '14:00' });
  ok('thursday 1-2pm is accepted', r.ok === true, JSON.stringify(r));
}
ok('a full 1-3pm window is accepted', f().noteTimeSlot({ day: 'tue', startTime: '13:00', endTime: '15:00' }).ok === true);
ok('evening 5-8pm is accepted', f().noteTimeSlot({ day: 'wed', startTime: '17:00', endTime: '20:00' }).ok === true);
ok('saturday 10:30 is accepted', f().noteTimeSlot({ day: 'sat', startTime: '10:30', endTime: '12:00' }).ok === true);

{
  const r = f().noteTimeSlot({ day: 'mon', startTime: '09:00', endTime: '10:00' });
  ok('a weekday morning is refused', r.ok === false);
  ok('...and the refusal says what he is free for', /13:00-15:00/.test(r.error || ''), r.error);
}
ok('saturday before 10am is refused', f().noteTimeSlot({ day: 'sat', startTime: '09:00', endTime: '11:00' }).ok === false);
ok('sunday is refused', f().noteTimeSlot({ day: 'sun', startTime: '13:00', endTime: '14:00' }).ok === false);
ok('a slot that straddles the end of a window is refused', f().noteTimeSlot({ day: 'thu', startTime: '14:00', endTime: '16:00' }).ok === false);
ok('end before start is refused', f().noteTimeSlot({ day: 'thu', startTime: '15:00', endTime: '13:00' }).ok === false);
ok('a nonsense time is refused', f().noteTimeSlot({ day: 'thu', startTime: 'afternoon', endTime: '15:00' }).ok === false);
ok('a nonsense day is refused', f().noteTimeSlot({ day: 'blursday', startTime: '13:00', endTime: '14:00' }).ok === false);

console.log('\ndates on slots');
{
  // Build a date that really is the coming Thursday, so the test does not rot.
  const d = new Date();
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7 || 7));
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const r = f().noteTimeSlot({ day: 'thu', date: iso, startTime: '13:00', endTime: '14:00' });
  ok('a correct date is accepted', r.ok === true, JSON.stringify(r));

  const wrong = f().noteTimeSlot({ day: 'fri', date: iso, startTime: '13:00', endTime: '14:00' });
  ok('a date that is not that weekday is refused', wrong.ok === false, JSON.stringify(wrong));
  ok('...and it says which weekday it really is', /is a thu/.test(wrong.error || ''), wrong.error);

  const past = f().noteTimeSlot({ day: 'thu', date: '2020-01-02', startTime: '13:00', endTime: '14:00' });
  ok('a date in the past is refused', past.ok === false);
  ok('a malformed date is refused', f().noteTimeSlot({ day: 'thu', date: 'next thursday', startTime: '13:00', endTime: '14:00' }).ok === false);
}

console.log('\ncollecting two slots');
{
  const n = f();
  const a = n.noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '15:00' });
  ok('first slot says one more is needed', a.stillNeeded === 1, JSON.stringify(a));
  const dup = n.noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '15:00' });
  ok('the same slot twice does not count twice', n.slots.length === 1, JSON.stringify(dup));
  const b = n.noteTimeSlot({ day: 'sat', startTime: '10:00', endTime: '12:00' });
  ok('second slot clears the requirement', b.stillNeeded === 0);
  const c = n.noteTimeSlot({ day: 'fri', startTime: '17:00', endTime: '19:00' });
  ok('a valid third slot is still accepted', c.ok === true);
}

console.log('\nmoney and minutes');
{
  const n = f();
  ok('a quote range is recorded', n.noteQuote({ lowUsd: 150, highUsd: 250 }).ok === true);
  ok('...and is not flagged over budget', n.quote.overBudget === false);
  ok('a quote above the budget is flagged', f().noteQuote({ lowUsd: 900 }).overBudget === true);
  ok('a single figure fills both ends', (() => { const x = f(); x.noteQuote({ lowUsd: 200 }); return x.quote.highUsd === 200; })());
  ok('a non-numeric price is refused', f().noteQuote({ lowUsd: 'a couple hundred' }).ok === false);
  ok('a free call-out is recorded, not treated as missing', f().noteCallout({ feeUsd: 0 }).ok === true);
  ok('a call-out with no number is refused', f().noteCallout({ feeUsd: 'depends' }).ok === false);
  ok('a duration is recorded', f().noteJobDuration({ minMinutes: 60, maxMinutes: 90 }).ok === true);
  // The bug this replaces: the ceiling was 24 hours, so "an hour to maybe two
  // days" had its maximum silently dropped and recorded as a flat 60 minutes.
  ok('two days is a real answer, not an error', (() => {
    const x = f();
    const r = x.noteJobDuration({ minMinutes: 60, maxMinutes: 2880 });
    return r.ok === true && x.jobDuration.minMinutes === 60 && x.jobDuration.maxMinutes === 2880;
  })());
  ok('a maximum we cannot use is refused, never quietly replaced by the minimum', (() => {
    const x = f();
    const r = x.noteJobDuration({ minMinutes: 60, maxMinutes: 'a couple of days' });
    return r.ok === false && x.jobDuration === null;
  })());
  ok('a single figure still fills both ends', (() => {
    const x = f();
    x.noteJobDuration({ minMinutes: 45 });
    return x.jobDuration.minMinutes === 45 && x.jobDuration.maxMinutes === 45;
  })());
  ok('a backwards range is refused', f().noteJobDuration({ minMinutes: 120, maxMinutes: 30 }).ok === false);
  ok('an absurd duration is still refused', f().noteJobDuration({ minMinutes: 99999 }).ok === false);
  ok('a non-numeric duration is refused', f().noteVisitDuration({ minMinutes: 'half an hour' }).ok === false);
}

console.log('\ncorrecting a time slot');
{
  // A contractor said "Thursday, 1 to 3", then corrected himself to "1 to 2".
  // Both were kept, and the portal showed the stale one - so the customer
  // would have been told the wrong window.
  const thu = () => new Findings({
    client: 'Yihan Sun',
    windows: [{ day: 'thu', startMin: 12 * 60, endMin: 18 * 60 }],
  });

  ok('a corrected window replaces the one it overlaps', (() => {
    const x = thu();
    x.noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '15:00', theirWords: '1 to 3' });
    const r = x.noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '14:00', theirWords: '1 to 2' });
    return r.ok === true && x.slots.length === 1 && x.slots[0].endTime === '14:00';
  })());

  ok('...and says so, so she can read the right one back', (() => {
    const x = thu();
    x.noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '15:00' });
    return String(x.noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '14:00' }).note || '').includes('replaced');
  })());

  ok('a genuinely separate window on the same day is still kept', (() => {
    const x = thu();
    x.noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '14:00' });
    x.noteTimeSlot({ day: 'thu', startTime: '16:00', endTime: '17:00' });
    return x.slots.length === 2;
  })());

  ok('an identical repeat is not counted twice', (() => {
    const x = thu();
    x.noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '14:00' });
    x.noteTimeSlot({ day: 'thu', startTime: '13:00', endTime: '14:00' });
    return x.slots.length === 1;
  })());
}

console.log('\nsilence is not an answer');
// She has to have asked before any of these answers mean anything, so every
// case below starts with the greeting and the question already delivered.
const asked = (n) => {
  n.noteAgentTurn('Hi, this is Mia, an AI assistant calling for Yihan Sun.');
  n.noteAgentTurn('Do you cover Redmond, 98053?');
  return n;
};
{
  // This is the bug that hung up on a real caller mid-sentence: Whisper
  // returned an empty transcript, the model read that nothing as "no, we
  // don't cover you", and the call ended while they were still talking.
  const n = asked(f());
  n.noteCallerTurn('');
  const r = n.noteServiceArea({ covers: false, theirWords: 'Okay' });
  ok('out of area cannot be recorded off a blank transcript', r.ok === false, JSON.stringify(r));
  ok('...and it tells her to go and ask properly', /ask/i.test(r.error || ''), r.error);
  ok('...and nothing was written down', n.serviceArea === null);

  const e = runTool(n, 'end_call', { reason: 'out_of_area' });
  ok('and she cannot hang up on silence either', e.ok === false, JSON.stringify(e));
  ok('...so the line stays open', n.hangup === null);
}
{
  // The same guard must not get in the way of a real answer.
  const n = asked(f());
  n.noteCallerTurn('No, we only cover Seattle proper.');
  ok('a real out of area answer still records', n.noteServiceArea({ covers: false }).ok === true);
  let ended = null;
  ok('...and she can hang up on it', runTool(n, 'end_call', { reason: 'out_of_area' }, { onEndCall: (r) => (ended = r) }).ok !== false);
  ok('...and the server is told', ended === 'out_of_area');
}
{
  // "Yes we cover you" does not end the call, so it never needs the guard.
  const n = asked(f());
  n.noteCallerTurn('');
  ok('a yes is recorded even on a patchy line', n.noteServiceArea({ covers: true }).ok === true);
}
{
  // The real call: Dave said "Okay." while she was still mid-paragraph, and she
  // wrote down "yes, they cover it" before the question had even finished
  // playing down the line. The greeting is not a question.
  const n = f();
  n.noteAgentTurn('Hi, this is Mia, an AI assistant calling for Yihan Sun.');
  n.noteCallerTurn('Hi, this is Dave, Appliance Repair.');
  n.noteCallerTurn('Okay.');
  const r = n.noteServiceArea({ covers: true, theirWords: 'Okay.' });
  ok('an answer cannot be recorded before she has finished asking', r.ok === false, JSON.stringify(r));
  ok('...and nothing was written down', n.serviceArea === null);
  ok('...and once she has asked, it records', asked(n).noteServiceArea({ covers: true }).ok === true);
}
{
  // A question the caller never heard is not a question that was asked.
  const n = f();
  ok('the greeting alone is not a question', f().askedSomething() === false);
  n.noteAgentTurn('');
  ok('a turn with no words does not count', n.agentTurns === 0);
}
{
  // Saying goodbye at the natural end of a call rests on nothing they said.
  const n = f();
  ok('a normal goodbye is never blocked', runTool(n, 'end_call', { reason: 'said_goodbye' }).ok !== false);
  const h = f();
  ok('a hostile caller can always be let go', runTool(h, 'end_call', { reason: 'hostile' }).ok !== false);
}
{
  // A later silence must not wipe out an answer they already gave.
  const n = f();
  n.noteCallerTurn('Yeah we cover Redmond.');
  n.noteCallerTurn('');
  ok('a blank turn after a real one still blocks a call-ending verdict', n.noteServiceArea({ covers: false }).ok === false);
  ok('...because the thing we just heard was nothing', n.heardSomething() === false);
}

console.log('\na late machine verdict never beats a live person');
{
  // The base fix for this lives in dialer.js: Twilio is asked for a plain
  // human-or-machine verdict with a five second ceiling, instead of being told
  // to wait for an answering machine to finish its outgoing greeting. That is
  // what made a verdict land thirty seconds in, halfway through a real
  // conversation, and hang up on the man we were talking to.
  const src = fs.readFileSync(new URL('./dialer.js', import.meta.url), 'utf8');
  ok('machine detection is not told to wait for a message to end', !/machineDetection:\s*'DetectMessageEnd'/.test(src));
  ok('...it just answers human or machine', /machineDetection:\s*'Enable'/.test(src));
  ok('...within a hard time limit', /machineDetectionTimeout:\s*\d+/.test(src));
  const secs = Number((src.match(/machineDetectionTimeout:\s*(\d+)/) || [])[1]);
  ok('...and that limit is short enough to beat any conversation', secs > 0 && secs <= 10, `${secs}s`);
}
{
  // A real voicemail must still be recordable. Its greeting is speech, and it
  // can easily transcribe as several turns, so nothing here may depend on how
  // much the other end said.
  const n = f();
  n.noteCallerTurn('Hi, you have reached Dave at Appliance Repair.');
  n.noteCallerTurn('We are not available right now.');
  n.noteCallerTurn('Please leave a message after the tone.');
  ok('voicemail is recorded however chatty its greeting is', n.noteBadPickup('voicemail', 'Twilio heard machine_start').ok === true);
  ok('...and the call is filed as no_answer', n.outcome.outcome === 'no_answer');
}

console.log('\nrefusals and outcome');
{
  const n = f();
  const r = n.noteDeclined({ topic: 'repair price', theirWords: 'I do not quote over the phone' });
  ok('a refusal is recorded', r.ok === true);
  ok('...and tells the agent to stop asking', /do not ask about that again/.test(r.note || ''), r.note);
  n.noteCallerTurn('We do not go out that far, sorry.');
  asked(n);
  n.noteServiceArea({ covers: false });
  ok('an out of area answer is recorded', n.serviceArea.covers === false);
  n.noteOutcome({ outcome: 'out_of_area', summary: 'they only do the east side' });
  ok('the outcome is recorded', n.outcome.outcome === 'out_of_area');
}

console.log('\ntool dispatch');
{
  const n = f();
  ok('every tool name maps to a handler', TOOLS.every((t) => t.name === 'end_call' || runTool(n, t.name, {}) !== undefined));
  ok('an unknown tool is refused, not thrown', runTool(n, 'note_vibes', {}).ok === false);

  let ended = null;
  const r = runTool(n, 'end_call', { reason: 'said_goodbye' }, { onEndCall: (why) => (ended = why) });
  ok('end_call reaches the server', ended === 'said_goodbye');
  ok('end_call is recorded on the notes', n.hangup?.reason === 'said_goodbye');
  ok('...and tells her to finish the goodbye first', /goodbye/.test(r.note || ''), r.note);

  const r2 = runTool(n, 'note_time_slot', { day: 'mon', startTime: '08:00', endTime: '09:00' });
  ok('a refused slot comes back with a reason she can say out loud', r2.ok === false && r2.error.length > 20);
}

console.log('\ntool schemas');
{
  ok('every tool has a name and a description', TOOLS.every((t) => t.name && t.description && t.type === 'function'));
  ok('every tool has an object parameter schema', TOOLS.every((t) => t.parameters?.type === 'object'));
  ok('every required field is actually declared', TOOLS.every((t) => (t.parameters.required || []).every((k) => k in t.parameters.properties)));
  const money = TOOLS.filter((t) => t.name === 'note_quote' || t.name === 'note_callout');
  ok('both money tools demand a read-back', money.every((t) => /say .*back/i.test(t.description)), money.map((t) => t.name).join());
  const slot = TOOLS.find((t) => t.name === 'note_time_slot');
  ok('the slot tool demands a read-back', /say the day, the date and the hour back/i.test(slot.description));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
