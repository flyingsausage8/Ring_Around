// What the call was for: the numbers and times worth keeping once it ends.
//
// The model decides what someone meant and calls a tool with the values. This
// file only stores them, checks they are the right shape, and compares times
// against the availability windows. It never reads the conversation.

import { cfg, toMinutes } from './config.js';
import * as log from './log.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Two weeks. Long enough for "it could be a couple of days" to be recorded
// honestly, short enough that a typo like 99999 is still caught.
const MAX_MINUTES = 60 * 24 * 14;

export class Findings {
  constructor(job = cfg.job) {
    this.job = job;
    this.serviceArea = null;   // do they cover the zip
    this.quote = null;         // rough price for the repair
    this.jobDuration = null;   // how long the repair takes on site
    this.callout = null;       // fee to come out, and whether it is credited
    this.visitDuration = null; // how long the estimate visit takes
    this.leadTime = null;      // how soon they could come out
    this.slots = [];           // times that work for both sides
    this.declined = [];        // what they would not answer, so we stop asking
    this.outcome = null;
    this.hangup = null;        // why the agent ended the call
    this.badPickup = null;     // a machine answered, or nobody did
    this.keysPressed = [];     // keypad presses, for menus and hold queues
    this.callerTurns = 0;      // how many times they have actually said something
    this.agentTurns = 0;       // how many of her own turns have finished
    this.lastCallerEmpty = true; // did the last thing we transcribed come back blank
  }

  // Fed from the transcriber. Counting turns and checking whether text came
  // back blank - no reading of what was said.
  noteCallerTurn(text) {
    const said = String(text ?? '').trim();
    this.lastCallerEmpty = said.length === 0;
    if (!this.lastCallerEmpty) this.callerTurns++;
    return this.callerTurns;
  }

  // Counted when one of her own turns finishes. The first one is the greeting,
  // which asks nothing about the job - so until a second one has finished, she
  // has not asked a question yet, whatever she thinks she heard the answer to.
  noteAgentTurn(text) {
    if (String(text ?? '').trim()) this.agentTurns++;
    return this.agentTurns;
  }

  // Has she finished asking anything beyond hello?
  askedSomething() {
    return this.agentTurns >= 2;
  }

  // Some decisions end the call. Those must not rest on a transcript that came
  // back empty, which is what silence, a cough or a bad line look like.
  heardSomething() {
    return this.callerTurns > 0 && !this.lastCallerEmpty;
  }

  // --- helpers -------------------------------------------------------------

  #money(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null;
  }

  #minutes(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= MAX_MINUTES ? n : null;
  }

  // Durations, in one place, because the failure mode here is quiet and nasty.
  // A repair really can take two days, and the old ceiling of 24 hours turned
  // "an hour to maybe two days" into a flat "60 minutes" without a word of
  // complaint - the maximum failed to parse and silently became the minimum.
  // A number we cannot use is now refused out loud rather than replaced with
  // a wrong one.
  #duration(minMinutes, maxMinutes, theirWords) {
    const min = this.#minutes(minMinutes);
    if (min === null) {
      return { ok: false, error: `need the shortest time in minutes, between 1 and ${MAX_MINUTES}` };
    }
    let max = min;
    if (maxMinutes !== null && maxMinutes !== undefined && maxMinutes !== '') {
      max = this.#minutes(maxMinutes);
      if (max === null) {
        return { ok: false, error: `need the longest time in minutes, between 1 and ${MAX_MINUTES}. Two days is 2880.` };
      }
      if (max < min) {
        return { ok: false, error: 'the longest time cannot be shorter than the shortest time - check which way round they said it' };
      }
    }
    return { ok: true, value: { minMinutes: min, maxMinutes: max, theirWords } };
  }

  // --- tool handlers -------------------------------------------------------

  noteServiceArea({ covers, theirWords }) {
    // She recorded "yes, they cover it" off a bare "Okay." - in the same breath
    // as asking the question, before the words had even reached the caller. The
    // greeting asks nothing about the job, so until a second turn of hers has
    // finished, there is no question for this to be the answer to.
    if (!this.askedSomething()) {
      return {
        ok: false,
        error:
          'you have not finished asking them yet. Ask whether they cover the area, let them answer, and record it after that.',
      };
    }
    // "They do not cover it" ends the call, so it is the one answer we refuse
    // to take on faith. If the last thing we transcribed was blank, they did
    // not answer - the line was quiet, or it was a cough, or they had not
    // finished. Ask again rather than hanging up on someone mid-sentence.
    if (covers === false && !this.heardSomething()) {
      return {
        ok: false,
        error:
          'you have not actually heard them answer that yet - the line was quiet. Ask whether they cover the area, wait for a real answer, and only then record it.',
      };
    }
    this.serviceArea = { covers: !!covers, theirWords };
    return { ok: true };
  }

  noteQuote({ lowUsd, highUsd, basis, theirWords }) {
    const low = this.#money(lowUsd);
    const high = this.#money(highUsd) ?? low;
    if (low === null && high === null) {
      return { ok: false, error: 'need at least one dollar amount as a number' };
    }
    const overBudget =
      this.job.budgetHigh && low !== null ? low > this.job.budgetHigh : false;
    this.quote = { lowUsd: low, highUsd: high, basis, theirWords, overBudget };
    return { ok: true, overBudget };
  }

  noteJobDuration({ minMinutes, maxMinutes, theirWords }) {
    const r = this.#duration(minMinutes, maxMinutes, theirWords);
    if (!r.ok) return r;
    this.jobDuration = r.value;
    return { ok: true };
  }

  noteCallout({ feeUsd, waivedIfRepaired, theirWords }) {
    const fee = this.#money(feeUsd);
    if (fee === null) return { ok: false, error: 'need the fee as a number, or 0 if there is none' };
    this.callout = {
      feeUsd: fee,
      waivedIfRepaired: waivedIfRepaired === null || waivedIfRepaired === undefined ? null : !!waivedIfRepaired,
      theirWords,
    };
    return { ok: true };
  }

  noteVisitDuration({ minMinutes, maxMinutes, theirWords }) {
    const r = this.#duration(minMinutes, maxMinutes, theirWords);
    if (!r.ok) return r;
    this.visitDuration = r.value;
    return { ok: true };
  }

  noteLeadTime({ soonest, theirWords }) {
    if (!soonest) return { ok: false, error: 'need a short description of how soon' };
    this.leadTime = { soonest, theirWords };
    return { ok: true };
  }

  // The one place code overrules the model. A slot that falls outside the
  // client's stated availability is rejected here, with the reason handed back
  // so the agent can say so on the call. This is a comparison of clock values,
  // not an interpretation of anything said.
  noteTimeSlot({ day, date, startTime, endTime, theirWords }) {
    const d = String(day || '').slice(0, 3).toLowerCase();
    if (!DAYS.includes(d)) {
      return { ok: false, error: `day must be one of ${DAYS.join(', ')}` };
    }
    const start = toMinutes(startTime);
    const end = toMinutes(endTime);
    if (start === null || end === null) {
      return { ok: false, error: 'times must be 24 hour HH:MM, like 13:00' };
    }
    if (end <= start) return { ok: false, error: 'end time must be after start time' };

    // If a date came with it, make sure it really is that weekday and is not
    // in the past. Calendar arithmetic, not interpretation.
    let iso = null;
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        return { ok: false, error: 'date must look like 2026-09-17' };
      }
      const when = new Date(`${date}T00:00:00`);
      if (Number.isNaN(when.getTime())) return { ok: false, error: 'that date does not exist' };
      if (DAYS[when.getDay()] !== d) {
        return { ok: false, error: `${date} is a ${DAYS[when.getDay()]}, not a ${d}. Check the date with them.` };
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (when < today) return { ok: false, error: `${date} is in the past` };
      iso = date;
    }

    const windows = this.job.windows || [];
    const fits = windows.some((w) => w.day === d && start >= w.startMin && end <= w.endMin);
    if (!fits) {
      const forDay = windows.filter((w) => w.day === d);
      const when = forDay.length
        ? forDay.map((w) => `${fmt(w.startMin)}-${fmt(w.endMin)}`).join(' or ')
        : 'nothing at all that day';
      return {
        ok: false,
        error: `outside what ${this.job.client} is free for. On ${d} that is ${when}. Tell them it does not work and ask for another time.`,
      };
    }

    if (this.slots.some((s) => s.day === d && s.startMin === start && s.endMin === end)) {
      return { ok: true, note: 'already had that one', slots: this.slots.length };
    }

    // A correction, not a second appointment. Nobody offers two overlapping
    // visits on the same date for the same job - when they say "sorry, one to
    // two" after "one to three", the later one replaces the earlier. Comparing
    // clock values on the same date; no reading of what was said.
    const clash = this.slots.findIndex(
      (s) => s.day === d && s.date === iso && start < s.endMin && end > s.startMin,
    );
    const slot = { day: d, date: iso, startTime, endTime, startMin: start, endMin: end, theirWords };
    if (clash >= 0) {
      const old = this.slots[clash];
      this.slots[clash] = slot;
      return {
        ok: true,
        note: `replaced the earlier ${fmt(old.startMin)}-${fmt(old.endMin)} on that date with this one`,
        slots: this.slots.length,
        stillNeeded: Math.max(0, 2 - this.slots.length),
      };
    }

    this.slots.push(slot);
    return { ok: true, slots: this.slots.length, stillNeeded: Math.max(0, 2 - this.slots.length) };
  }

  noteDeclined({ topic, theirWords }) {
    if (!topic) return { ok: false, error: 'need the topic they would not answer' };
    this.declined.push({ topic, theirWords });
    return { ok: true, note: 'noted - do not ask about that again' };
  }

  noteOutcome({ outcome, summary }) {
    this.outcome = { outcome, summary };
    return { ok: true };
  }

  noteHangup(reason) {
    this.hangup = { reason, at: Date.now() };
    return { ok: true };
  }

  // A machine picked up, or nobody did. This is a real outcome, not a failure
  // - it just means there is nothing to be got from this number today.
  noteBadPickup(kind, theirWords) {
    this.badPickup = { kind, theirWords };
    if (!this.outcome) this.outcome = { outcome: kind === 'wrong_number' ? 'declined' : 'no_answer', summary: `${kind} picked up` };
    return { ok: true };
  }

  // What we pressed, and what we were told to press it for. A call that ended
  // in a menu is worth being able to read back afterwards.
  notePressedKeys(digits, why) {
    this.keysPressed.push({ digits, why: why || null });
    return { ok: true };
  }

  // --- output --------------------------------------------------------------

  toJSON() {
    return {
      client: this.job.client,
      area: this.job.area,
      zip: this.job.zip,
      issue: this.job.issue,
      serviceArea: this.serviceArea,
      quote: this.quote,
      jobDuration: this.jobDuration,
      callout: this.callout,
      visitDuration: this.visitDuration,
      leadTime: this.leadTime,
      slots: this.slots.map(({ day, date, startTime, endTime, theirWords }) => ({ day, date, startTime, endTime, theirWords })),
      declined: this.declined,
      outcome: this.outcome,
      hangup: this.hangup,
      badPickup: this.badPickup,
      keysPressed: this.keysPressed,
    };
  }

  print() {
    const q = this.quote;
    const c = this.callout;
    const rows = [
      ['service area', this.serviceArea ? (this.serviceArea.covers ? `covers ${this.job.zip}` : 'DOES NOT COVER') : '-'],
      ['quote', q ? money(q.lowUsd, q.highUsd) + (q.overBudget ? '  (over budget)' : '') : '-'],
      ['repair takes', span(this.jobDuration)],
      ['call-out fee', c ? `$${c.feeUsd}${c.waivedIfRepaired === true ? ', waived if repaired' : c.waivedIfRepaired === false ? ', not waived' : ''}` : '-'],
      ['visit takes', span(this.visitDuration)],
      ['can come', this.leadTime?.soonest || '-'],
      ['slot 1', this.slots[0] ? slot(this.slots[0]) : '-'],
      ['slot 2', this.slots[1] ? slot(this.slots[1]) : '-'],
      ['would not say', this.declined.map((d) => d.topic).join(', ') || '-'],
      ['outcome', this.outcome?.outcome || '-'],
      ['hung up because', this.hangup?.reason || '-'],
    ];
    log.info('call notes', '');
    for (const [k, v] of rows) console.log(`         ${k.padEnd(14)} ${v}`);
  }
}

function fmt(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function money(low, high) {
  if (low === null && high === null) return '-';
  if (high === null || high === low) return `$${low}`;
  return `$${low} - $${high}`;
}

function span(d) {
  if (!d) return '-';
  const a = d.minMinutes;
  const b = d.maxMinutes;
  if (b === null || b === a) return `${a} min`;
  return `${a} - ${b} min`;
}

function slot(s) {
  return `${s.day}${s.date ? ' ' + s.date : ''} ${s.startTime}-${s.endTime}`;
}
