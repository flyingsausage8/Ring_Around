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

export function makeDialer({ client = null, toOverride = null } = {}) {
  const twilioClient = client || twilio(cfg.twilioSid, cfg.twilioToken);

  return async function dial(item) {
    // Every number is checked again here, at the last possible moment. The
    // queue checked at load time; this catches anything that changed since.
    assertProvenance(item);

    // Phone mode: everything is dialled to my own number instead, so the
    // agent can be rehearsed against a real line without ringing a business.
    const to = toOverride || item.phone;
    if (toOverride && to !== cfg.to) {
      throw new Error('phone mode may only dial MY_VERIFIED_NUMBER');
    }

    if (!cfg.publicHost) throw new Error('PUBLIC_HOST is empty - Twilio has nowhere to call back');

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
