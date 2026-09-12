// The job everything else is about: who the customer is, what is broken, where
// it is, and when they are free.
//
// Until now this lived in .env and was read once at startup, which meant
// changing the job meant editing a file and restarting the server. Step 1 of
// the portal now builds it from a conversation instead, so it has to be
// something that can change while the process is running - and every part of
// the system that cares has to read it at the moment it needs it, not at
// import time.
//
// Kept on disk so a restart does not throw away what the customer typed.

import fs from 'node:fs';
import path from 'node:path';
import { cfg, parseWindows } from './config.js';
import * as log from './log.js';

const FILE = path.join(process.cwd(), 'job.json');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// What must be known before we are willing to call anybody. Everything else is
// a nice-to-have the agent can say "I'm not sure" about.
const REQUIRED = ['client', 'area', 'issue'];

let current = load();

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    log.info('job', `loaded the saved job for ${saved.client || 'someone'}`);
    return { ...structuredClone(cfg.job), ...saved };
  } catch {
    return structuredClone(cfg.job);
  }
}

// The parts of a job that belong to one particular customer. Everything else -
// the search radius, who we are calling on behalf of - is a setting and
// survives.
const CUSTOMER_FIELDS = [
  'client', 'area', 'zip', 'issue', 'brand', 'fuel', 'age',
  'address', 'phone', 'availability', 'budgetLow', 'budgetHigh', 'lat', 'lng',
];

// Blank means blank. The fields are emptied rather than removed, because a
// missing key would just be filled back in from the config defaults the next
// time the file is read - and the customer would find themselves talking about
// somebody else's oven.
function blankJob() {
  const job = structuredClone(cfg.job);
  for (const k of CUSTOMER_FIELDS) job[k] = typeof job[k] === 'number' ? null : '';
  job.windows = [];
  return job;
}

export function getJob() {
  return current;
}

// What is still missing, in the order it is worth asking about. Counting
// fields, not reading them.
export function missingFields(job = current) {
  const gaps = REQUIRED.filter((k) => !String(job[k] ?? '').trim());
  if (!job.windows?.length) gaps.push('availability');
  return gaps;
}

export function isReady(job = current) {
  return missingFields(job).length === 0;
}

// Merge in whatever we have learned. Values that fail their own format are
// dropped rather than stored wrong - a half-typed zip is worse than no zip,
// because discovery would search the wrong place and sound confident doing it.
export function updateJob(patch = {}) {
  const next = { ...current };
  const rejected = [];

  const str = (k) => {
    if (patch[k] === undefined || patch[k] === null) return;
    const v = String(patch[k]).trim();
    if (v) next[k] = v;
  };
  for (const k of ['client', 'company', 'area', 'issue', 'brand', 'fuel', 'age', 'address', 'phone', 'availability']) str(k);

  if (patch.zip !== undefined && patch.zip !== null) {
    const z = String(patch.zip).trim();
    // A US zip is a fixed five digit format. This is a shape check on a field,
    // not an attempt to understand anything anybody said.
    if (/^\d{5}$/.test(z)) next.zip = z;
    else if (z) rejected.push(`zip "${z}" is not five digits`);
  }

  for (const k of ['budgetLow', 'budgetHigh']) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    const n = Number(patch[k]);
    if (Number.isFinite(n) && n >= 0 && n < 100000) next[k] = n;
    else rejected.push(`${k} "${patch[k]}" is not a sensible amount of money`);
  }

  if (Array.isArray(patch.windows)) {
    const windows = [];
    for (const w of patch.windows) {
      const day = String(w?.day ?? '').slice(0, 3).toLowerCase();
      const startMin = toMinutes(w?.startTime);
      const endMin = toMinutes(w?.endTime);
      if (!DAYS.includes(day)) { rejected.push(`"${w?.day}" is not a day`); continue; }
      if (startMin === null || endMin === null) { rejected.push(`"${w?.startTime}-${w?.endTime}" is not a time range`); continue; }
      if (endMin <= startMin) { rejected.push(`${w.startTime}-${w.endTime} ends before it starts`); continue; }
      windows.push({ day, startMin, endMin });
    }
    if (windows.length) {
      next.windows = windows;
      next.availability = patch.availability ? String(patch.availability).trim() : describeWindows(windows);
    }
  }

  if (Number.isFinite(Number(patch.lat)) && Number.isFinite(Number(patch.lng))) {
    next.lat = Number(patch.lat);
    next.lng = Number(patch.lng);
  }

  current = next;
  save();
  return { job: current, rejected, missing: missingFields(current), ready: isReady(current) };
}

export function resetJob() {
  current = blankJob();
  save();
  return current;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  } catch (err) {
    log.warn('job', `could not save the job: ${err.message}`);
  }
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function fmtTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

// A sentence the agent can say out loud, built from the windows themselves so
// the words and the numbers can never drift apart.
export function describeWindows(windows = current.windows || []) {
  if (!windows.length) return 'no times given yet';
  const byRange = new Map();
  for (const w of windows) {
    const key = `${w.startMin}-${w.endMin}`;
    if (!byRange.has(key)) byRange.set(key, []);
    byRange.get(key).push(w.day);
  }
  const parts = [];
  for (const [key, days] of byRange) {
    const [s, e] = key.split('-').map(Number);
    const ordered = DAYS.filter((d) => days.includes(d));
    parts.push(`${ordered.map(dayName).join(', ')} ${fmtTime(s)} to ${fmtTime(e)}`);
  }
  return parts.join('; ');
}

function dayName(d) {
  return { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' }[d] || d;
}

export { parseWindows };
