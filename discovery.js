// Finding companies to call.
//
// Two sources, both explicit, neither a fallback for the other:
//   fixture - contractors.local.json, saved from a real search. Offline, free,
//             repeatable. Use it for testing and demos.
//   places  - Google Places text search. The live source.
//
// If Places fails, discovery fails. It does NOT quietly serve the fixture
// instead: a stale file dressed up as a fresh search is how you end up calling
// a company that closed last year, and nobody would ever notice the API had
// broken. Ask for the fixture if you want the fixture.
//
// THE RULE THAT MATTERS - PHONE NUMBERS
// A phone number may only come from a structured field returned by the API.
// Never from a model, never scraped out of a description, a review or a web
// page. Everything here goes through assertProvenance(), which throws rather
// than hand back a number it cannot account for. A wrong number does not fail
// quietly - it rings a stranger's house, and an AI starts talking to them.

import fs from 'node:fs';
import * as log from './log.js';

const FIXTURE = 'contractors.local.json';
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';

// Where a number is allowed to have come from. Anything else is refused.
const TRUSTED_SOURCES = new Set(['google_places', 'fixture', 'manual']);

// Mechanical shape check, not interpretation: US numbers are 10 digits, or 11
// starting with a 1. Anything else is not something we will dial.
export function toE164(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// The gate every contractor passes through before anyone can dial it.
export function assertProvenance(c) {
  if (!c || typeof c !== 'object') throw new Error('not a contractor');
  if (!TRUSTED_SOURCES.has(c.phoneSource)) {
    throw new Error(
      `${c.name || 'a contractor'} has a phone number from "${c.phoneSource}" - only ${[...TRUSTED_SOURCES].join(', ')} are allowed. A number from anywhere else could ring anyone.`,
    );
  }
  if (!c.phone || !toE164(c.phone)) {
    throw new Error(`${c.name || 'a contractor'} has no dialable phone number: ${JSON.stringify(c.phone)}`);
  }
  return c;
}

export function assertAllProvenance(list) {
  list.forEach(assertProvenance);
  return list;
}

// ---------------------------------------------------------------------------
// Source 1: the fixture
// ---------------------------------------------------------------------------

export function loadFixture({ path = FIXTURE, limit = 10 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${path}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }

  const rows = data.appliance_repair;
  if (!Array.isArray(rows)) throw new Error(`${path} has no appliance_repair array`);

  const out = [];
  for (const row of rows) {
    const phone = toE164(row.phone);
    if (!phone) {
      log.warn('discovery', `skipping ${row.name || 'an unnamed entry'} - no dialable number in the fixture`);
      continue;
    }
    out.push({
      name: row.name,
      phone,
      phoneRaw: row.phone,
      // The fixture was saved from a real Places search, so its numbers came
      // from the same structured field. Tagged separately so it is obvious in
      // the logs which run used saved data.
      phoneSource: 'fixture',
      address: row.address || '',
      rating: row.rating ?? null,
      reviews: row.reviews ?? null,
      placeId: row.placeId || null,
      source: 'fixture',
    });
    if (out.length >= limit) break;
  }

  assertAllProvenance(out);
  log.info('discovery', `${out.length} contractors from ${path} (saved ${data._fetched || 'at some point'})`);
  return out;
}

// ---------------------------------------------------------------------------
// Source 2: Google Places
// ---------------------------------------------------------------------------

// Only these fields are requested, and the phone is read from exactly one of
// them. Asking for less also keeps the bill down - Places charges by field.
const FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
].join(',');

export async function searchPlaces({
  query = 'appliance repair',
  area = '',
  limit = 10,
  key = process.env.GOOGLE_MAPS_API_KEY,
  fetchImpl = fetch,
} = {}) {
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not set - cannot search Places');

  const textQuery = area ? `${query} in ${area}` : query;
  log.stage('DISCOVERY_SEARCH', `places text search: ${JSON.stringify(textQuery)} limit=${limit}`);

  let res;
  try {
    res = await fetchImpl(PLACES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELDS,
      },
      body: JSON.stringify({ textQuery, maxResultCount: Math.min(limit, 20), languageCode: 'en' }),
    });
  } catch (err) {
    throw new Error(`could not reach Google Places: ${err.message}`);
  }

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Google Places returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new Error(`Google Places sent something that is not JSON: ${err.message}`);
  }

  const places = data.places || [];
  const out = [];
  let noPhone = 0;
  let closed = 0;

  for (const p of places) {
    const name = p.displayName?.text || p.displayName || '(unnamed)';

    if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') {
      closed++;
      log.info('discovery', `skipping ${name} - Places says ${p.businessStatus}`);
      continue;
    }

    // The only place a phone number is ever read from. One structured field,
    // nothing else on the response is even looked at for this.
    const fromApi = p.nationalPhoneNumber || p.internationalPhoneNumber || null;
    const phone = toE164(fromApi);
    if (!phone) {
      noPhone++;
      log.info('discovery', `skipping ${name} - Places has no phone number for them`);
      continue;
    }

    out.push({
      name,
      phone,
      phoneRaw: fromApi,
      phoneSource: 'google_places',
      address: p.formattedAddress || '',
      rating: p.rating ?? null,
      reviews: p.userRatingCount ?? null,
      placeId: p.id || null,
      source: 'places',
    });
    if (out.length >= limit) break;
  }

  assertAllProvenance(out);
  log.stage(
    'DISCOVERY_RESULTS',
    `${out.length} usable from ${places.length} results${noPhone ? `, ${noPhone} had no number` : ''}${closed ? `, ${closed} not operating` : ''}`,
  );
  return out;
}

// ---------------------------------------------------------------------------

// source is chosen by the caller, on purpose. There is no automatic failover:
// if Places is asked for and Places breaks, this throws, and whoever asked
// finds out rather than being handed yesterday's file.
export async function discover({ source = 'places', ...opts } = {}) {
  if (source === 'fixture') return loadFixture(opts);
  if (source === 'places') return searchPlaces(opts);
  throw new Error(`unknown discovery source: ${source} (use "places" or "fixture")`);
}

export function printContractors(list) {
  for (const [i, c] of list.entries()) {
    const stars = c.rating ? `${c.rating}* (${c.reviews ?? '?'})` : 'unrated';
    console.log(`  ${String(i + 1).padStart(2)}. ${c.name}`);
    console.log(`      ${c.phone}  ${stars}  [${c.phoneSource}]`);
    if (c.address) console.log(`      ${c.address}`);
  }
}
