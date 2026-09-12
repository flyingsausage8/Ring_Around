// The queue's promises, checked without a phone anywhere near it.
//
// What matters here is not that calls happen, but that they happen one at a
// time, in order, that pause lets the current call finish, that stop does not,
// and that a number nobody can account for never gets dialled.

import { CallQueue } from './queue.js';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

const T = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Shop ${i + 1}`,
    phone: `+1206555000${i}`,
    phoneSource: 'fixture',
  }));

// A dialer that records the order it was asked to dial in, and lets the test
// decide when each call ends.
function recordingDialer(opts = {}) {
  const calls = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const dial = async (item) => {
    calls.push(item.phone);
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const finish = (result) => {
      concurrent--;
      resolveDone(result);
    };
    const session = {
      done,
      hangUpNow(why) {
        if (session.ended) return;
        session.ended = true;
        session.stoppedWith = why;
        finish({ outcome: 'stopped', why, durationSeconds: 1 });
      },
    };
    dial.live = session;
    setTimeout(() => {
      if (session.ended) return;
      session.ended = true;
      finish({ outcome: opts.outcome || 'quote_only', durationSeconds: 2 });
    }, opts.ms ?? 20);
    return { session, callSid: 'CA' + item.i };
  };
  dial.calls = calls;
  dial.maxConcurrent = () => maxConcurrent;
  return dial;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nqueue');

await (async () => {
  const dial = recordingDialer();
  const q = new CallQueue({ dialer: dial });
  eq('starts idle', q.state, 'idle');
  eq('loads three', q.load(T(3)), 3);
  await q.start();

  eq('called all three', dial.calls.length, 3);
  eq('in the order given', dial.calls.join(','), '+12065550000,+12065550001,+12065550002');
  eq('never two at once', dial.maxConcurrent(), 1);
  eq('nothing left waiting', q.status().waiting, 0);
  eq('every call has an outcome', q.status().items.every((x) => x.outcome === 'quote_only'), true);
  eq('ends done', q.state, 'done');
})();

console.log('\npause finishes the call it is on');

await (async () => {
  const dial = recordingDialer({ ms: 120 });
  const q = new CallQueue({ dialer: dial });
  q.load(T(4));
  const run = q.start();

  await sleep(40);
  eq('first call in progress', q.state, 'in_call');
  q.pause();
  eq('says pausing', q.state, 'pausing');
  await run;

  eq('only the first was dialled', dial.calls.length, 1);
  eq('and it was not cut off', q.status().items[0].outcome, 'quote_only');
  eq('the rest are still waiting', q.status().waiting, 3);

  // Resume picks up where it stopped, and does not redial the finished one.
  await q.resume();
  eq('resumed through the rest', dial.calls.length, 4);
  eq('without repeating the first', new Set(dial.calls).size, 4);
})();

console.log('\nstop cuts in');

await (async () => {
  const dial = recordingDialer({ ms: 5000 });
  const q = new CallQueue({ dialer: dial });
  q.load(T(4));
  const run = q.start();

  await sleep(40);
  const live = dial.live;
  q.stop('red button');
  await run;

  eq('hung up the live call', live.stoppedWith, 'red button');
  eq('that call is marked stopped', q.status().items[0].outcome, 'stopped');
  eq('nothing else was dialled', dial.calls.length, 1);
  eq('the rest are untouched', q.status().waiting, 3);
})();

console.log('\na failed call does not stop the list, and is never retried');

await (async () => {
  let n = 0;
  const dial = async (item) => {
    n++;
    if (item.i === 1) throw new Error('line dead');
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    setTimeout(() => resolveDone({ outcome: 'quote_only', durationSeconds: 1 }), 10);
    return { session: { done, hangUpNow() {} }, callSid: 'CA' };
  };
  const q = new CallQueue({ dialer: dial });
  q.load(T(3));
  await q.start();

  eq('tried each number exactly once', n, 3);
  eq('the bad one is marked failed', q.status().items[1].outcome, 'failed');
  eq('with the reason kept', q.status().items[1].error, 'line dead');
  eq('the ones after it still ran', q.status().items[2].outcome, 'quote_only');
})();

console.log('\nguards');

await (async () => {
  const q = new CallQueue({ dialer: recordingDialer() });

  let threw = '';
  try {
    q.load([{ name: 'Scraped Co', phone: '+12065551234', phoneSource: 'model' }]);
  } catch (err) {
    threw = err.message;
  }
  ok('refuses a number a model produced', threw.length > 0, threw);

  threw = '';
  try {
    q.load([{ name: 'No source', phone: '+12065551234' }]);
  } catch (err) {
    threw = err.message;
  }
  ok('refuses a number with no provenance at all', threw.length > 0, threw);

  threw = '';
  try {
    q.load([]);
  } catch (err) {
    threw = err.message;
  }
  ok('refuses an empty list', threw.includes('nothing'), threw);

  threw = '';
  try {
    await q.start();
  } catch (err) {
    threw = err.message;
  }
  ok('refuses to start with nothing loaded', threw.includes('nothing loaded'), threw);

  q.load(T(2));
  const run = q.start();
  threw = '';
  try {
    await q.start();
  } catch (err) {
    threw = err.message;
  }
  ok('refuses to start twice', threw.includes('already running'), threw);
  await run;
})();

await (async () => {
  const dial = recordingDialer({ ms: 200 });
  const q = new CallQueue({ dialer: dial });
  q.load(T(2));
  const run = q.start();
  await sleep(30);
  let threw = '';
  try {
    q.reset();
  } catch (err) {
    threw = err.message;
  }
  ok('refuses to clear the list mid-call', threw.includes('stop the queue'), threw);
  q.stop();
  await run;
})();

console.log('\nstatus');

await (async () => {
  const seen = [];
  const dial = recordingDialer({ ms: 30 });
  const q = new CallQueue({ dialer: dial, onChange: (s) => seen.push(s.state) });
  q.load(T(1));
  await q.start();
  ok('reported dialling', seen.includes('dialling'), seen.join(','));
  ok('reported in_call', seen.includes('in_call'), seen.join(','));
  ok('reported done', seen.includes('done'), seen.join(','));
})();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
