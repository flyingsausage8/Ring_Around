// Placing a call and handing back the live session.
//
// Twilio dials, then calls us back on /twiml, then opens a media socket. The
// queue wants none of that detail - it wants "here is a call in progress".
// This bridges the two: dial, wait for the socket to attach, hand it over.

import twilio from 'twilio';
import { cfg } from './config.js';
import { assertProvenance } from './discovery.js';
import * as log from './log.js';

// Sessions that have been dialled but whose media socket has not arrived yet.
// Twilio does not tell us the streamSid in advance, and there is only ever one
// call in flight, so one slot is all we need - which is itself a guard: a
// second concurrent call would have nowhere to go.
let pending = null;

export function claimPending(session) {
  const p = pending;
  pending = null;
  if (p) p.attach(session);
  return !!p;
}

export function hasPending() {
  return !!pending;
}

// Ask the outside world whether it can still see us. The free tunnels this
// runs behind die several times a day and take a new hostname with them, and
// nothing about that failure is visible from inside this process.
export async function assertReachable() {
  const url = `https://${cfg.publicHost}/twiml`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=preflight',
    });
  } catch (err) {
    log.fail('TUNNEL', `${cfg.publicHost} is unreachable: ${err.message}`);
    throw new Error(`the tunnel is down - Twilio cannot reach ${cfg.publicHost}. Restart cloudflared and update PUBLIC_HOST.`);
  }
  if (!res.ok) {
    log.fail('TUNNEL', `${url} returned ${res.status}`);
    throw new Error(`the tunnel answered ${res.status}, not 200 - Twilio would hear an application error. Restart cloudflared and update PUBLIC_HOST.`);
  }
  const body = await res.text();
  if (!body.includes('<Stream')) {
    throw new Error('the tunnel reached something, but it was not this server');
  }
  log.stage('TUNNEL', `${cfg.publicHost} answers - safe to dial`);
}

export function makeDialer({ client = null, toOverride = null } = {}) {
  const twilioClient = client || twilio(cfg.twilioSid, cfg.twilioToken);

  return async function dial(item) {
    // Every number is checked again here, at the last possible moment. The
    // queue checked at load time; this catches anything that changed since.
    assertProvenance(item);

    if (!cfg.publicHost) throw new Error('PUBLIC_HOST is empty - Twilio has nowhere to call back');

    // Twilio has to be able to fetch /twiml from the outside world. When the
    // tunnel is dead the call still connects and the caller hears "an
    // application error has occurred" - which looks like the agent broke, but
    // is really the door being shut. Check the door before ringing anyone.
    await assertReachable();

    // Phone mode: everything is dialled to my own number instead, so the
    // agent can be rehearsed against a real line without ringing a business.
    const to = toOverride || item.phone;
    if (toOverride && to !== cfg.to) {
      throw new Error('phone mode may only dial MY_VERIFIED_NUMBER');
    }

    let attach;
    const attached = new Promise((resolve) => {
      attach = resolve;
    });
    pending = { item, attach, at: Date.now() };

    let call;
    try {
      call = await twilioClient.calls.create({
        to,
        from: cfg.from,
        url: `https://${cfg.publicHost}/twiml`,
        statusCallback: `https://${cfg.publicHost}/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeout: cfg.ringSeconds,
        // Ask Twilio who picked up. Without this a voicemail greeting looks
        // exactly like a person who has gone quiet, and the agent talks to an
        // answering machine for a full minute.
        //
        // 'Enable' answers one question - human or machine - and answers it as
        // soon as it knows. 'DetectMessageEnd' is the other mode: it waits for
        // a machine to finish its outgoing greeting so you can leave a message
        // after the beep. We never leave a message, so that mode bought us
        // nothing and cost us thirty seconds of listening, which is how a
        // verdict once landed in the middle of a real conversation and hung up
        // on the man we were talking to.
        machineDetection: 'Enable',
        // And a hard ceiling, so a verdict can never arrive late enough to
        // contradict a conversation that is already under way.
        machineDetectionTimeout: 5,
        asyncAmd: 'true',
        asyncAmdStatusCallback: `https://${cfg.publicHost}/amd`,
        asyncAmdStatusCallbackMethod: 'POST',
      });
    } catch (err) {
      pending = null;
      throw new Error(`Twilio would not place the call: ${err.message}`);
    }

    log.stage('CALL_CREATE', `sid=${call.sid} ${cfg.from} -> ${to} status=${call.status}`);

    // If nobody picks up, no socket ever arrives. Give it the ring time plus
    // a margin, then give up on this one and let the queue move on.
    const waitMs = (cfg.ringSeconds + 20) * 1000;
    const session = await Promise.race([
      attached,
      new Promise((_, reject) =>
        setTimeout(() => {
          if (pending) pending = null;
          reject(new Error(`no answer - nobody picked up within ${Math.round(waitMs / 1000)}s`));
        }, waitMs),
      ),
    ]);

    return { session, callSid: call.sid };
  };
}

// Used by the queue in dry runs and tests: no phone, no Twilio, no money.
export function makeFakeDialer(script = {}) {
  return async function fakeDial(item) {
    assertProvenance(item);
    log.info('queue', `(pretend) calling ${item.name} ${item.phone}`);
    const outcome = script[item.phone] || script.default || 'quote_only';
    if (outcome === 'failed') throw new Error('pretend failure');

    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const session = {
      done,
      hangUpNow(why) {
        resolveDone({ outcome: 'stopped', why, durationSeconds: 1, spokeToAPerson: false, findings: {}, files: null });
      },
    };
    setTimeout(
      () => resolveDone({ outcome, durationSeconds: 2, spokeToAPerson: outcome !== 'no_answer', findings: {}, files: null }),
      script.ms ?? 50,
    );
    return { session, callSid: `CAfake${item.i}` };
  };
}
