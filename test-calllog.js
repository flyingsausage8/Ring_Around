// Who gets rung again, and who does not.
//
// The cost of getting this wrong is a real person being phoned twice about the
// same broken oven, so the rule is tested against made-up call files rather
// than trusted to read correctly.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phoneKey, callHistory, annotate, split } from './calllog.js';

let passed = 0;
let failed = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringaround-calls-'));

let n = 0;
function saveCall(phone, outcome, { badPickup = null, at = null, name = 'Someone' } = {}) {
  n++;
  const startedAt = at || new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  fs.writeFileSync(
    path.join(dir, `${startedAt.replace(/[:.]/g, '-')}-CA${n}.json`),
    JSON.stringify({
      target: { name, phone },
      outcome: outcome ? { outcome } : null,
      badPickup: badPickup ? { kind: badPickup } : null,
      startedAt,
      durationSeconds: 30,
    }),
  );
  // A transcript sits next to every call file and must never be counted as one.
  fs.writeFileSync(path.join(dir, `${startedAt.replace(/[:.]/g, '-')}-CA${n}.transcript.json`), '{"lines":[]}');
}

console.log('\nwho we have already called');

check('a number is the same number however it is written', phoneKey('+1 (425) 555-0101'), '4255550101');
check('...with or without the country code', phoneKey('4255550101'), '4255550101');
check('a blank number is no number', phoneKey(''), '');

saveCall('+14255550101', 'booked', { name: 'Booked Co' });
saveCall('+14255550102', 'declined', { name: 'Declined Co' });
saveCall('+14255550103', 'quote_only', { name: 'Quoted Co' });
saveCall('+14255550104', 'out_of_area', { name: 'Far Away Co' });
saveCall('+14255550105', 'no_answer', { name: 'Rang Out Co' });
saveCall('+14255550106', 'no_answer', { badPickup: 'voicemail', name: 'Voicemail Co' });
saveCall('+14255550107', 'call_back_later', { name: 'Busy Co' });

const list = [
  { name: 'Booked Co', phone: '+14255550101' },
  { name: 'Declined Co', phone: '+14255550102' },
  { name: 'Quoted Co', phone: '+14255550103' },
  { name: 'Far Away Co', phone: '+14255550104' },
  { name: 'Rang Out Co', phone: '+14255550105' },
  { name: 'Voicemail Co', phone: '+14255550106' },
  { name: 'Busy Co', phone: '+14255550107' },
  { name: 'Brand New Co', phone: '+14255550108' },
];

const parts = split(list, dir);
check('the ones we finished with are left alone', parts.skip.map((c) => c.name), ['Booked Co', 'Declined Co', 'Quoted Co', 'Far Away Co']);
check('the ones we never reached get another go', parts.toCall.map((c) => c.name), ['Rang Out Co', 'Voicemail Co', 'Busy Co', 'Brand New Co']);
check('nobody is lost between the two lists', parts.skip.length + parts.toCall.length, list.length);

const marked = annotate(list, dir);
check('a new company has no history', marked[7].calledBefore, null);
check('and is not finished with', marked[7].finished, false);
check('a booked one says what happened', marked[0].calledBefore.lastOutcome, 'booked');
check('transcripts are not mistaken for calls', marked[0].calledBefore.attempts, 1);

// Rang out twice, then actually spoke to them. They are finished.
saveCall('+14255550105', 'no_answer', { name: 'Rang Out Co' });
saveCall('+14255550105', 'quote_only', { name: 'Rang Out Co' });
const after = split(list, dir);
check('three tries and a quote means we are done', after.skip.map((c) => c.name).indexOf('Rang Out Co') > -1, true);
check('and the attempts are counted', callHistory(dir).get('4255550105').attempts, 3);
check('and the latest answer is the one shown', callHistory(dir).get('4255550105').lastOutcome, 'quote_only');

// A later bad redial must not reopen a company that already said no.
saveCall('+14255550102', 'no_answer', { name: 'Declined Co' });
check('a no is still a no after a later rang-out', split(list, dir).skip.map((c) => c.name).indexOf('Declined Co') > -1, true);

// The same number written differently is still the same contractor.
check('a differently formatted number is still recognised', split([{ name: 'Booked Co', phone: '425-555-0101' }], dir).skip.length, 1);

check('no call files at all means everybody is new', split(list, path.join(dir, 'nope')).toCall.length, list.length);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
