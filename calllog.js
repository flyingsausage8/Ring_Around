// Who we have already rung, and whether there is any point ringing them again.
//
// Built from the call files on disk rather than a list of its own. A separate
// "already called" file would be a second version of the truth, and the day it
// disagreed with calls/ somebody would get rung twice at dinner.
//
// The rule is not "have we dialled this number". It is "did we finish with
// them". A company that quoted us, booked us in, or said no is finished - ring
// them again and we are a nuisance. A company whose phone rang out, or whose
// menu we could not work, was never actually spoken to, and is worth another
// try. That distinction is the whole file.

import fs from 'node:fs';
import path from 'node:path';

// Outcomes that mean the conversation happened and reached an end.
const FINISHED = new Set(['booked', 'quote_only', 'declined', 'out_of_area', 'wrong_trade']);

function digitsOf(phone) {
  return String(phone ?? '').replace(/[^\d]/g, '');
}

// Same number, however it was written down. +1 425 555 0101 and 4255550101
// are one contractor, and only one of them should be rung.
export function phoneKey(phone) {
  const d = digitsOf(phone);
  if (!d) return '';
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

export function readCalls(dir = path.join(process.cwd(), 'calls')) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.transcript.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      out.push({
        phone: r.target?.phone || '',
        name: r.target?.name || '',
        outcome: r.outcome?.outcome || null,
        badPickup: r.badPickup?.kind || null,
        startedAt: r.startedAt || null,
        durationSeconds: r.durationSeconds ?? null,
      });
    } catch {
      // A half-written file from a crash is not a reason to forget everyone.
    }
  }
  return out;
}

// phone -> what we know about ringing it.
export function callHistory(dir) {
  const byPhone = new Map();
  for (const c of readCalls(dir)) {
    const key = phoneKey(c.phone);
    if (!key) continue;
    const row = byPhone.get(key) || { attempts: 0, lastOutcome: null, lastAt: null, finished: false, name: c.name };
    row.attempts++;
    // Once finished, always finished - a later bad redial does not reopen a
    // company that already said no.
    if (FINISHED.has(c.outcome)) row.finished = true;
    if (!row.lastAt || String(c.startedAt) > String(row.lastAt)) {
      row.lastAt = c.startedAt;
      row.lastOutcome = c.outcome || c.badPickup || 'ended';
    }
    byPhone.set(key, row);
  }
  return byPhone;
}

// Hang what we know onto each contractor, without dropping anybody. The
// decision to skip belongs to whoever is about to dial, not to this.
export function annotate(contractors, dir) {
  const seen = callHistory(dir);
  return contractors.map((c) => {
    const row = seen.get(phoneKey(c.phone));
    if (!row) return { ...c, attempts: 0, calledBefore: null, finished: false };
    return {
      ...c,
      attempts: row.attempts,
      calledBefore: { attempts: row.attempts, lastOutcome: row.lastOutcome, lastAt: row.lastAt },
      finished: row.finished,
    };
  });
}

// Split a list into the ones worth dialling and the ones we are done with.
export function split(contractors, dir) {
  const marked = annotate(contractors, dir);
  return {
    toCall: marked.filter((c) => !c.finished),
    skip: marked.filter((c) => c.finished),
  };
}

export { FINISHED };
