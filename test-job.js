// The job store: what it accepts, what it refuses, and when it says a job is
// ready to call about.
//
// These are the guards that stand between a customer typing something odd and
// a real contractor being told something wrong, so they are worth checking one
// by one.

import { updateJob, resetJob, getJob, missingFields, isReady, describeWindows, fmtTime } from './job.js';

let passed = 0;
let failed = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('\njob store');

resetJob();
check('a new job knows nothing', missingFields().sort(), ['area', 'availability', 'client', 'issue']);
check('and is not ready', isReady(), false);

updateJob({ client: '  Yihan Sun  ', area: 'Redmond, WA', issue: 'oven will not heat' });
check('trims what it stores', getJob().client, 'Yihan Sun');
check('only availability left', missingFields(), ['availability']);

let r = updateJob({ zip: '9805' });
check('a four digit zip is refused', r.rejected.length, 1);
check('and nothing is stored', getJob().zip, '');

r = updateJob({ zip: '98052' });
check('a real zip is kept', getJob().zip, '98052');
check('with nothing rejected', r.rejected, []);

r = updateJob({ budgetLow: 'about two hundred' });
check('a budget in words is refused', r.rejected.length, 1);
r = updateJob({ budgetLow: 150, budgetHigh: 400 });
check('a budget in numbers is kept', [getJob().budgetLow, getJob().budgetHigh], [150, 400]);

r = updateJob({ windows: [{ day: 'mon', startTime: '21:00', endTime: '18:00' }] });
check('a window that ends before it starts is refused', r.rejected.length, 1);
check('so the job still has no times', getJob().windows, []);

r = updateJob({ windows: [{ day: 'funday', startTime: '09:00', endTime: '12:00' }] });
check('a day that is not a day is refused', r.rejected.length, 1);

r = updateJob({ windows: [{ day: 'mon', startTime: 'evening', endTime: 'late' }] });
check('times that are not times are refused', r.rejected.length, 1);

r = updateJob({
  windows: [
    { day: 'mon', startTime: '18:00', endTime: '21:00' },
    { day: 'tue', startTime: '18:00', endTime: '21:00' },
    { day: 'sat', startTime: '09:00', endTime: '12:00' },
  ],
});
check('real windows are stored as minutes', getJob().windows[0], { day: 'mon', startMin: 1080, endMin: 1260 });
check('nothing is missing now', missingFields(), []);
check('so the job is ready', isReady(), true);

check('windows read back in plain words', describeWindows(getJob().windows), 'Monday, Tuesday 6pm to 9pm; Saturday 9am to 12pm');
check('a spoken sentence is written for the agent', getJob().availability, 'Monday, Tuesday 6pm to 9pm; Saturday 9am to 12pm');

check('midday reads as 12pm', fmtTime(720), '12pm');
check('midnight reads as 12am', fmtTime(0), '12am');
check('and half past shows the minutes', fmtTime(1050), '5:30pm');

// A good window followed by a bad one in the same call: the good one must not
// be lost because its neighbour was wrong.
r = updateJob({
  windows: [
    { day: 'wed', startTime: '10:00', endTime: '11:00' },
    { day: 'wed', startTime: '99:99', endTime: '11:00' },
  ],
});
check('a bad window does not take the good one with it', getJob().windows.length, 1);
check('and it says which one it dropped', r.rejected.length, 1);

// Starting over must leave nothing of the last customer behind.
updateJob({ client: 'Someone Else', area: 'Seattle', issue: 'fridge', zip: '98101' });
resetJob();
check('starting over forgets the name', getJob().client, '');
check('starting over forgets the zip', getJob().zip, '');
check('starting over forgets the times', getJob().windows, []);
check('starting over keeps the search radius', typeof getJob().radiusMeters, 'number');

resetJob();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
