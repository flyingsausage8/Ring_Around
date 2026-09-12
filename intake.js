// Step 1: find out what the job actually is, by talking to the customer.
//
// This replaces a block of JOB_* variables in .env. A person types "my oven
// won't heat up and I'm free after work" and this turns it into the structured
// job that discovery searches with and the agent calls about.
//
// The division of labour is the same one the phone agent uses: the model reads
// what the person wrote and fills in fields; the code checks the fields are
// usable and decides when there is enough to proceed. There is no pattern
// matching against anything the customer typed - if the model does not put a
// zip code in the zip field, we do not go hunting for one in the prose.

import { cfg } from './config.js';
import { getJob, updateJob, missingFields, describeWindows, fmtTime } from './job.js';
import * as log from './log.js';

const MODEL = process.env.AZURE_INTAKE_DEPLOYMENT || 'gpt-5-mini';
const API_VERSION = '2024-10-21';

const SAVE_TOOL = {
  type: 'function',
  function: {
    name: 'save_details',
    description:
      'Write down what you have learned about the job. Call this every time the customer tells you something new, with only the fields you actually learned. Never guess at a value.',
    parameters: {
      type: 'object',
      properties: {
        client: { type: 'string', description: 'The customer\'s name, as they would like it said to a contractor.' },
        area: { type: 'string', description: 'Town or neighbourhood, e.g. "Redmond, WA".' },
        zip: { type: 'string', description: 'Five digit US zip code.' },
        issue: {
          type: 'string',
          description:
            'What is wrong, in one or two plain sentences, written so a repair company hears it read out loud. Include the error code or symptom if given.',
        },
        brand: { type: 'string', description: 'Appliance make, if they know it.' },
        fuel: { type: 'string', description: 'Gas, electric, induction, and so on.' },
        age: { type: 'string', description: 'Roughly how old the appliance is.' },
        address: { type: 'string', description: 'Street address. Never said on a call - only used once a visit is agreed.' },
        phone: { type: 'string', description: 'The customer\'s own phone number, for the contractor to confirm with.' },
        budgetLow: { type: 'number', description: 'Bottom of what they are willing to spend, in dollars.' },
        budgetHigh: { type: 'number', description: 'Top of what they are willing to spend, in dollars.' },
        windows: {
          type: 'array',
          description:
            'Every window the customer has actually told you they are free. Convert their own plain language into days and 24 hour clock times. Never include a window they have not stated - ask instead.',
          items: {
            type: 'object',
            properties: {
              day: { type: 'string', enum: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
              startTime: { type: 'string', description: '24 hour, HH:MM.' },
              endTime: { type: 'string', description: '24 hour, HH:MM.' },
            },
            required: ['day', 'startTime', 'endTime'],
          },
        },
      },
    },
  },
};

function systemPrompt(job) {
  return `
You are the intake assistant for Ring Around. A person has an appliance that
has broken, and this service phones repair companies on their behalf to get
quotes and book a visit. Your job is to find out enough that those calls can
actually happen, and then hand over.

You are talking to the customer, in a chat box. You are NOT on the phone and
you are NOT the one who calls the contractors - a voice agent does that
afterwards. If they ask, say so plainly.

HOW YOU WRITE
Short. Warm. One question at a time. No bullet lists, no forms, no numbered
questions. You are a person helping, not a web form with a personality.
Never ask for something they have already told you.

WHAT YOU NEED BEFORE ANYTHING CAN HAPPEN
  1. Their name - the contractor will be told who the visit is for.
  2. Where it is - the town, and the zip code if they know it.
  3. What is broken, and what it is doing.
  4. When they are free for someone to come out.

WHAT IS WORTH HAVING, BUT NEVER WORTH NAGGING FOR
The make, the fuel or type, roughly how old it is, a budget, and the error code
if there is one. Ask once, in passing. "Not sure" is a perfectly good answer
and you move on - the agent is allowed to tell a contractor they do not know
something, but it is not allowed to invent an answer, so a guess from you here
becomes a lie on a real phone call.

TIMES ARE THE PART PEOPLE ARE VAGUEST ABOUT
"Whenever" and "after work" cannot be checked against what a contractor
offers, so turn them into real hours - ask what time they finish, or what
counts as too late. Get at least one window, and two or three is much better,
because every window you miss is a slot the agent has to turn down.

NEVER WRITE DOWN A TIME THEY DID NOT GIVE YOU
Any clock time in these instructions is an example of the format, never an
answer. A window you invented is worse than no window at all: a contractor
will be booked for it, and nobody will be home.

WRITING IT DOWN
Call save_details as soon as you learn anything, with just the new fields. Do
not wait until the end. Only ever write down what this customer told you -
anything already shown below is theirs, and everything else is a guess. If the
tool tells you something was rejected, it means the value could not be used -
ask them for it again rather than arguing with it.

WHEN YOU HAVE ENOUGH
Say what you have got in two or three lines - name, place, problem, times - and
tell them they can start the search. Do not say a call is being placed; they
press the button, not you.

THE JOB SO FAR
${JSON.stringify(
  Object.fromEntries(
    ['client', 'area', 'zip', 'issue', 'brand', 'fuel', 'age', 'address', 'phone', 'budgetLow', 'budgetHigh']
      .map((k) => [k, job[k] || null]),
  ),
  null,
  1,
)}
Times recorded: ${describeWindows(job.windows)}
Still needed: ${missingFields(job).join(', ') || 'nothing - they can go ahead'}
`.trim();
}

async function ask(messages) {
  const host = cfg.azureEndpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${host}/openai/deployments/${MODEL}/chat/completions?api-version=${API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': cfg.azureKey, 'content-type': 'application/json' },
    body: JSON.stringify({ messages, tools: [SAVE_TOOL], tool_choice: 'auto', max_completion_tokens: 3000 }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`intake model said ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// One turn of the conversation. `history` is what the browser has shown so
// far; we rebuild the system prompt every time so it always carries the job as
// it stands right now rather than as it was when the chat began.
export async function intakeTurn(history = []) {
  const turns = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim())
    .slice(-24)
    .map((m) => ({ role: m.role, content: String(m.content) }));

  const messages = [{ role: 'system', content: systemPrompt(getJob()) }, ...turns];
  const saved = [];
  const rejected = [];

  // The model may want to write things down before it replies, and it is
  // allowed more than one go - it often saves the details, reads what came
  // back, and only then works out what to ask next.
  for (let round = 0; round < 4; round++) {
    const data = await ask(messages);
    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error('intake model returned nothing');

    const calls = choice.tool_calls || [];
    if (!calls.length) {
      const text = String(choice.content ?? '').trim();
      return { reply: text, job: getJob(), saved, rejected, missing: missingFields(), ready: !missingFields().length };
    }

    messages.push(choice);
    for (const call of calls) {
      let args = {};
      let result;
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch (err) {
        result = { ok: false, error: `could not read those arguments: ${err.message}` };
      }
      if (!result) {
        const out = updateJob(args);
        rejected.push(...out.rejected);
        saved.push(...Object.keys(args));
        result = {
          ok: true,
          rejected: out.rejected,
          stillNeeded: out.missing,
          timesRecorded: describeWindows(out.job.windows),
        };
        log.info('intake', `saved ${Object.keys(args).join(', ') || '(nothing)'}${out.rejected.length ? ` - rejected: ${out.rejected.join('; ')}` : ''}`);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return {
    reply: 'Sorry - I got stuck writing that down. Could you say that again?',
    job: getJob(),
    saved,
    rejected,
    missing: missingFields(),
    ready: !missingFields().length,
  };
}

// Turn a town or zip into coordinates. Discovery needs a real centre point:
// words alone once returned appliance shops in Iowa for a job in Redmond.
//
// This asks Places, not the Geocoding API, on purpose - Places is the one this
// key already has switched on, and it answers the same question. Asking
// Geocoding instead just gets REQUEST_DENIED and a silently uncentred search.
//
// Only re-asked when the place actually changes: this runs after every chat
// turn, and looking up the same town twenty times costs money and tells us
// nothing new.
let lastLocated = null;

export async function locate(job = getJob()) {
  const where = [job.address, job.area, job.zip].filter(Boolean).join(', ');
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!where || !key) return null;
  if (where === lastLocated && Number.isFinite(job.lat)) return null;

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.location,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: where, languageCode: 'en', regionCode: 'US', maxResultCount: 1 }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`place lookup said ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const hit = data.places?.[0]?.location;
  if (!hit) {
    log.warn('intake', `could not place "${where}" on a map - keeping the old centre`);
    return null;
  }
  updateJob({ lat: hit.latitude, lng: hit.longitude });
  lastLocated = where;
  log.info('intake', `centred the search on ${where} (${hit.latitude.toFixed(4)}, ${hit.longitude.toFixed(4)})`);
  return { lat: hit.latitude, lng: hit.longitude, where };
}

export { fmtTime };
