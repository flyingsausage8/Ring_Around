// The call queue. One call at a time, in order, and that is the whole design.
//
// No concurrency: two calls at once means two conversations in one pair of
// ears, and there is one person to answer for all of them.
// No retries: a contractor who was busy does not want to be rung straight
// back, and an agent that redials on its own is an agent that can dial
// forever. If a call goes badly it is marked and we move on.
//
// Three controls:
//   start  - work through the list
//   pause  - finish the call that is happening, then stop. Nobody gets hung
//            up on mid-sentence because someone changed their mind.
//   stop   - hang up now. The red button means now, not soon.

import { cfg } from './config.js';
import { assertProvenance } from './discovery.js';
import * as log from './log.js';

export const QUEUE_STATES = ['idle', 'dialling', 'in_call', 'pausing', 'stopping', 'done'];

export class CallQueue {
  constructor({ dialer, onChange = () => {} }) {
    if (typeof dialer !== 'function') throw new Error('the queue needs a dialer');
    this.dialer = dialer;
    this.onChange = onChange;

    this.state = 'idle';
    this.items = [];
    this.current = null;
    this.currentSession = null;
    this.running = false;
    this.mode = null;
    this.startedAt = null;
    this.stopRequested = false;
    this.pauseRequested = false;
  }

  #set(state) {
    this.state = state;
    this.onChange(this.status());
  }

  // Everything about to be dialled goes through the provenance gate first. A
  // number we cannot account for never reaches the phone.
  load(targets, { mode = 'contractors' } = {}) {
    if (this.running) throw new Error('the queue is already running - pause or stop it first');
    const list = targets.map((t, i) => {
      assertProvenance(t);
      return {
        i,
        name: t.name,
        phone: t.phone,
        phoneSource: t.phoneSource,
        address: t.address || '',
        rating: t.rating ?? null,
        reviews: t.reviews ?? null,
        status: 'waiting',
        outcome: null,
        callSid: null,
        files: null,
      };
    });
    if (!list.length) throw new Error('nothing to call');
    this.items = list;
    this.mode = mode;
    this.#set('idle');
    log.info('queue', `loaded ${list.length} to call, one at a time, no retries`);
    return list.length;
  }

  async start() {
    if (this.running) throw new Error('already running');
    if (!this.items.length) throw new Error('nothing loaded');
    this.running = true;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.startedAt = Date.now();
    log.stage('QUEUE_START', `${this.items.filter((x) => x.status === 'waiting').length} to call, mode=${this.mode}`);
    try {
      await this.#run();
    } finally {
      this.running = false;
      this.current = null;
      this.currentSession = null;
      const finished = this.items.filter((x) => x.status === 'done').length;
      this.#set(this.items.some((x) => x.status === 'waiting') ? 'idle' : 'done');
      log.stage('QUEUE_DONE', `${finished} of ${this.items.length} called`);
    }
  }

  async #run() {
    for (const item of this.items) {
      if (item.status !== 'waiting') continue;
      if (this.stopRequested) {
        log.warn('queue', 'stopped - the rest of the list was not called');
        break;
      }
      if (this.pauseRequested) {
        log.info('queue', 'paused - the rest of the list is still waiting');
        break;
      }

      this.current = item;
      item.status = 'calling';
      this.#set('dialling');
      log.stage('QUEUE_DIAL', `${item.i + 1}/${this.items.length} ${item.name} ${item.phone}`);

      try {
        const { session, callSid } = await this.dialer(item);
        item.callSid = callSid || null;
        this.currentSession = session;
        this.#set('in_call');

        const result = await session.done;
        item.outcome = result.outcome;
        item.files = result.files;
        item.durationSeconds = result.durationSeconds;
        item.spokeToAPerson = result.spokeToAPerson;
        item.findings = result.findings;
        log.stage('QUEUE_CALL_DONE', `${item.name}: ${result.outcome} after ${result.durationSeconds}s`);
      } catch (err) {
        // A call that would not even start is marked and left. Retrying is
        // how one bad number turns into fifty calls to the same house.
        item.outcome = 'failed';
        item.error = err.message;
        log.fail('QUEUE_DIAL', `${item.name}: ${err.message}`);
      } finally {
        item.status = 'done';
        this.current = null;
        this.currentSession = null;
        this.onChange(this.status());
      }

      const more = this.items.some((x) => x.status === 'waiting');
      if (more && !this.stopRequested && !this.pauseRequested) {
        this.#set('idle');
        await sleep(cfg.gapBetweenCallsMs);
      }
    }
  }

  // Finish what is happening, then stop. The person on the phone does not get
  // cut off because someone pressed a button in another room.
  pause() {
    if (!this.running) return this.status();
    this.pauseRequested = true;
    this.#set('pausing');
    log.info('queue', this.currentSession ? 'pausing - will stop after this call' : 'pausing');
    return this.status();
  }

  // Now. Not after the sentence, not after the call.
  stop(why = 'stopped from the control panel') {
    this.stopRequested = true;
    this.pauseRequested = true;
    this.#set('stopping');
    log.warn('queue', 'STOP - hanging up');
    if (this.currentSession) this.currentSession.hangUpNow(why);
    return this.status();
  }

  // Picking up where a pause left off. The calls already made stay made.
  resume() {
    if (this.running) throw new Error('already running');
    if (!this.items.some((x) => x.status === 'waiting')) throw new Error('everything has been called');
    return this.start();
  }

  reset() {
    if (this.running) throw new Error('stop the queue before clearing it');
    this.items = [];
    this.mode = null;
    this.#set('idle');
  }

  status() {
    return {
      state: this.state,
      running: this.running,
      mode: this.mode,
      total: this.items.length,
      waiting: this.items.filter((x) => x.status === 'waiting').length,
      done: this.items.filter((x) => x.status === 'done').length,
      current: this.current ? { name: this.current.name, phone: this.current.phone, callSid: this.current.callSid } : null,
      items: this.items.map((x) => ({
        name: x.name,
        phone: x.phone,
        status: x.status,
        outcome: x.outcome,
        durationSeconds: x.durationSeconds ?? null,
        error: x.error || null,
        files: x.files || null,
        rating: x.rating,
        reviews: x.reviews,
        // The finished rows ARE the comparison, so they have to carry their
        // own answers with them. There is no separate results page.
        findings: x.findings || null,
      })),
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
