// Tests for discovery.
//
// The provenance rule is the point of this file. A phone number that came from
// anywhere but a structured API field must never survive to the dialer,
// because the failure mode is not a crash - it is an AI phoning a stranger.
//
// Google Places is never actually called here. A fake fetch returns canned
// responses, so these run offline and for free.

import { loadFixture, searchPlaces, discover, assertProvenance, toE164, rank, score } from './discovery.js';

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
async function throws(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err.message;
  }
}

console.log('\nphone number shapes');
ok('a 10 digit number becomes E.164', toE164('(425) 500-3141') === '+14255003141');
ok('a leading 1 is handled', toE164('1-425-500-3141') === '+14255003141');
ok('an already formatted number survives', toE164('+14255003141') === '+14255003141');
ok('a short number is refused', toE164('555-1234') === null);
ok('an extension makes it unusable', toE164('425-500-3141 ext 2') === null);
ok('empty is refused', toE164('') === null);
ok('undefined is refused', toE164(undefined) === null);

console.log('\nprovenance - the rule that stops us dialling a stranger');
{
  const good = { name: 'Real Co', phone: '+14255003141', phoneSource: 'google_places' };
  ok('a number from the API is allowed', assertProvenance(good) === good);
  ok('a number from the fixture is allowed', !!assertProvenance({ ...good, phoneSource: 'fixture' }));
  ok('a number entered by hand is allowed', !!assertProvenance({ ...good, phoneSource: 'manual' }));

  const fromModel = await throws(() => assertProvenance({ ...good, phoneSource: 'model' }));
  ok('a number from a model is refused', fromModel !== null);
  ok('...and the error says why it matters', /ring anyone/i.test(fromModel || ''), fromModel);
  ok('a scraped number is refused', (await throws(() => assertProvenance({ ...good, phoneSource: 'scraped' }))) !== null);
  ok('a number from a website is refused', (await throws(() => assertProvenance({ ...good, phoneSource: 'website' }))) !== null);
  ok('an untagged number is refused', (await throws(() => assertProvenance({ name: 'X', phone: '+14255003141' }))) !== null);
  ok('a trusted tag on an undialable number is still refused', (await throws(() => assertProvenance({ ...good, phone: '555' }))) !== null);
}

console.log('\nthe fixture');
{
  const list = loadFixture();
  ok('it loads the appliance_repair array', list.length === 10);
  ok('every entry is dialable', list.every((c) => /^\+1\d{10}$/.test(c.phone)));
  ok('every entry is tagged as coming from the fixture', list.every((c) => c.phoneSource === 'fixture'));
  ok('every entry survives the provenance gate', list.every((c) => !!assertProvenance(c)));
  ok('names and addresses come through', list.every((c) => c.name && c.address));
  ok('the limit is respected', loadFixture({ limit: 3 }).length === 3);
  ok('a missing file fails loudly', (await throws(() => loadFixture({ path: 'nope.json' }))) !== null);
}

console.log('\ngoogle places');
function fakeFetch(payload, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });
}

{
  const list = await searchPlaces({
    key: 'test-key',
    area: 'Redmond WA',
    fetchImpl: fakeFetch({
      places: [
        {
          id: 'p1',
          displayName: { text: 'Alpha Appliance' },
          formattedAddress: '1 Main St, Redmond, WA',
          nationalPhoneNumber: '(425) 555-0101',
          rating: 4.8,
          userRatingCount: 120,
          businessStatus: 'OPERATIONAL',
        },
      ],
    }),
  });
  ok('a result becomes a contractor', list.length === 1);
  ok('the phone is normalised', list[0].phone === '+14255550101');
  ok('...and tagged as coming from Places', list[0].phoneSource === 'google_places');
  ok('the place id is kept', list[0].placeId === 'p1');
  ok('the rating comes through', list[0].rating === 4.8 && list[0].reviews === 120);
}

{
  // The important one: a business whose number only appears in prose. There is
  // no structured field, so there is no number, full stop.
  const list = await searchPlaces({
    key: 'test-key',
    fetchImpl: fakeFetch({
      places: [
        { id: 'p1', displayName: { text: 'No Phone Co' }, formattedAddress: 'Call us on 425-555-0199!', businessStatus: 'OPERATIONAL' },
        { id: 'p2', displayName: { text: 'Has Phone Co' }, nationalPhoneNumber: '425-555-0102', businessStatus: 'OPERATIONAL' },
      ],
    }),
  });
  ok('a number written in the address text is never picked up', list.length === 1);
  ok('...and the one with a real field is kept', list[0].name === 'Has Phone Co');
}

{
  const list = await searchPlaces({
    key: 'test-key',
    fetchImpl: fakeFetch({
      places: [
        { id: 'p1', displayName: { text: 'Closed Co' }, nationalPhoneNumber: '425-555-0103', businessStatus: 'CLOSED_PERMANENTLY' },
        { id: 'p2', displayName: { text: 'Open Co' }, nationalPhoneNumber: '425-555-0104', businessStatus: 'OPERATIONAL' },
      ],
    }),
  });
  ok('a permanently closed business is skipped', list.length === 1 && list[0].name === 'Open Co');
}

{
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`,
    displayName: { text: `Co ${i}` },
    nationalPhoneNumber: `425-555-${String(1000 + i).slice(-4)}`,
    businessStatus: 'OPERATIONAL',
  }));
  const list = await searchPlaces({ key: 'test-key', limit: 10, fetchImpl: fakeFetch({ places: many }) });
  ok('ten is what we asked for and ten is what we get', list.length === 10);
}

console.log('\nwhen places breaks, it breaks loudly');
{
  const denied = await throws(() => searchPlaces({ key: 'bad', fetchImpl: fakeFetch('{"error":{"message":"key not authorized"}}', { status: 403 }) }));
  ok('an HTTP error throws', denied !== null);
  ok('...and says what came back', /403/.test(denied || ''), denied);

  const garbage = await throws(() => searchPlaces({ key: 'k', fetchImpl: fakeFetch('<html>oops</html>') }));
  ok('a non-JSON response throws', garbage !== null);

  const offline = await throws(() =>
    searchPlaces({ key: 'k', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }),
  );
  ok('a network failure throws', offline !== null);

  ok('a missing API key throws before any request', (await throws(() => searchPlaces({ key: '' }))) !== null);

  // The whole point: no silent failover. A broken API must never be papered
  // over with yesterday's file, or nobody ever finds out it broke.
  const stillThrows = await throws(() =>
    discover({ source: 'places', key: 'k', fetchImpl: fakeFetch('nope', { status: 500 }) }),
  );
  ok('discover does NOT quietly fall back to the fixture', stillThrows !== null, 'it returned a list instead of throwing');
}

console.log('\nchoosing a source');
{
  ok('fixture is served when asked for', (await discover({ source: 'fixture', limit: 2 })).length === 2);
  ok('an unknown source throws', (await throws(() => discover({ source: 'vibes' }))) !== null);
}

console.log('\nwhat we ask Google for');
{
  let captured = null;
  await searchPlaces({
    key: 'test-key',
    query: 'appliance repair',
    area: 'Redmond WA 98053',
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 200, text: async () => '{"places":[]}' };
    },
  });
  ok('the key goes in a header, not the URL', !captured.url.includes('test-key') && captured.opts.headers['X-Goog-Api-Key'] === 'test-key');
  ok('the area is part of the query', JSON.parse(captured.opts.body).textQuery === 'appliance repair in Redmond WA 98053');
  ok('a phone field is requested', captured.opts.headers['X-Goog-FieldMask'].includes('nationalPhoneNumber'));
}

console.log('\nranking');
{
  const co = (name, rating, reviews) => ({ name, rating, reviews, phone: '+14255550100', phoneSource: 'fixture' });

  // The whole reason for the prior: one glowing review is not evidence.
  const list = rank([co('One Review', 5, 1), co('Well Reviewed', 4.8, 1135)]);
  ok('a 4.8 with a thousand reviews beats a 5.0 with one', list[0].name === 'Well Reviewed', JSON.stringify(list.map((c) => c.name)));

  // With enough reviews behind both, the better rating wins again.
  const solid = rank([co('Good', 4.6, 400), co('Better', 4.9, 400)]);
  ok('with equal evidence, the higher rating wins', solid[0].name === 'Better');

  // Same rating, more people saying it.
  const same = rank([co('Fewer', 4.9, 30), co('More', 4.9, 900)]);
  ok('same rating, more reviews ranks higher', same[0].name === 'More');

  ok('a score sits between the average and the rating', (() => {
    const s = score(co('X', 5, 20));
    return s > 4.3 && s < 5;
  })());
  ok('no reviews scores zero rather than crashing', score(co('X', 5, 0)) === 0);
  ok('a missing rating scores zero', score({ reviews: 100 }) === 0);
  ok('ranking does not mutate the list it was given', (() => {
    const original = [co('A', 4, 10), co('B', 5, 500)];
    rank(original);
    return original[0].name === 'A' && original[0].score === undefined;
  })());
  ok('every contractor survives ranking', rank(loadFixture()).length === 10);
  ok('discover ranks by default', (await discover({ source: 'fixture' }))[0].score !== undefined);
  ok('ranking can be turned off', (await discover({ source: 'fixture', ranked: false }))[0].score === undefined);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
