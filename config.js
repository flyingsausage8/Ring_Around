import 'dotenv/config';
import * as log from './log.js';

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'MY_VERIFIED_NUMBER',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_KEY',
];

export const cfg = {
  twilioSid: process.env.TWILIO_ACCOUNT_SID,
  twilioToken: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_PHONE_NUMBER,
  to: process.env.MY_VERIFIED_NUMBER,

  azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT,
  azureKey: process.env.AZURE_OPENAI_KEY,

  publicHost: (process.env.PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  port: Number(process.env.PORT || 8080),

  agentName: process.env.AGENT_NAME || 'Sam',
  voice: process.env.AGENT_VOICE || 'marin',
  // How long semantic VAD waits before deciding the other person has finished.
  //
  // This was set to "low" to stop her answering a "mm-hm" as if it were a whole
  // turn. It backfired badly: on a live call it waited so long for a "real" end
  // of turn that the contractor's speech barely registered at all - three turns
  // detected in thirty seconds, him repeating his own name to a line that was
  // not listening, and her monologuing over the top because nothing ever came
  // back as an interruption. Failing to hear someone is far worse than
  // answering them twice.
  //
  // "auto" is what she was doing better with. The double-reply it used to cause
  // is fixed properly now - in the tool follow-up rule in realtime.js, and in
  // the briefing - rather than by making her deaf.
  eagerness: process.env.AGENT_EAGERNESS || 'auto',
  speed: Number(process.env.AGENT_SPEED || 1),
  temperature: Number(process.env.AGENT_TEMPERATURE || 0.8),
  idleHangupSeconds: Number(process.env.IDLE_HANGUP_SECONDS || 20),
  maxCallSeconds: Number(process.env.MAX_CALL_SECONDS || 180),
  // How long we will sit on a line where nobody has said a word. Long enough
  // for a slow "hello?", short enough not to talk at an empty room.
  deadAirSeconds: Number(process.env.DEAD_AIR_SECONDS || 25),
  // A business answers the phone by saying who it is - "Appliance Repair, this
  // is Dave". Starting the instant the line opens talks straight over that, so
  // they miss the disclosure and spend the next twenty seconds repeating their
  // own name. Let them go first.
  greetingDelayMs: Number(process.env.GREETING_DELAY_MS || 2000),
  // How long the phone may ring before Twilio gives up.
  ringSeconds: Number(process.env.RING_SECONDS || 25),
  // Breathing room between calls, so the queue is not machine-gunning the line.
  gapBetweenCallsMs: Number(process.env.GAP_BETWEEN_CALLS_MS || 4000),

  // The demo job the agent is calling about. Placeholder until discovery
  // feeds real jobs in.
  job: {
    client: process.env.JOB_CLIENT || 'the client',
    company: process.env.JOB_COMPANY || '',
    area: process.env.JOB_AREA || 'the local area',
    zip: process.env.JOB_ZIP || '',
    // Where to centre the search for contractors. Words alone are a weak hint -
    // "appliance repair" with no coordinates returns shops in other states.
    lat: Number(process.env.JOB_LAT || 47.6740),
    lng: Number(process.env.JOB_LNG || -122.1215),
    radiusMeters: Number(process.env.JOB_RADIUS_METERS || 30000),
    address: process.env.JOB_ADDRESS || '',
    phone: process.env.JOB_PHONE || '',
    availability: process.env.JOB_AVAILABILITY || 'most weekday afternoons',
    issue: process.env.JOB_ISSUE || 'an appliance that has stopped working',
    brand: process.env.JOB_BRAND || '',
    fuel: process.env.JOB_FUEL || '',
    age: process.env.JOB_AGE || '',
    budgetLow: Number(process.env.JOB_BUDGET_LOW || 0) || null,
    budgetHigh: Number(process.env.JOB_BUDGET_HIGH || 0) || null,
  },
};

// "mon-fri 13:00-15:00; sat 10:00-23:59" -> windows we can compare against.
// Fixed config format, so matching its shape is mechanical - it never touches
// anything a person said.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseWindows(spec) {
  const out = [];
  for (const part of (spec || '').split(';')) {
    const text = part.trim();
    if (!text) continue;
    const m = /^([a-z]{3})(?:-([a-z]{3}))?\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/i.exec(text);
    if (!m) throw new Error(`bad availability window: "${text}"`);
    const [, fromDay, toDay, start, end] = m;
    const a = DAYS.indexOf(fromDay.toLowerCase());
    const b = toDay ? DAYS.indexOf(toDay.toLowerCase()) : a;
    if (a < 0 || b < 0) throw new Error(`bad day in window: "${text}"`);
    for (let d = a; ; d = (d + 1) % 7) {
      out.push({ day: DAYS[d], startMin: toMinutes(start), endMin: toMinutes(end) });
      if (d === b) break;
    }
  }
  return out;
}

export function toMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

cfg.job.windows = parseWindows(process.env.JOB_AVAILABILITY_WINDOWS || '');

// GA path. /openai/realtime?deployment= is preview only and 404s here.
export function azureRealtimeUrl() {
  const host = cfg.azureEndpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `wss://${host}/openai/v1/realtime?model=${encodeURIComponent(cfg.azureDeployment)}`;
}

export function checkEnv({ needPublicHost = false } = {}) {
  const missing = REQUIRED.filter((k) => !process.env[k] || !process.env[k].trim());
  if (needPublicHost && !cfg.publicHost) missing.push('PUBLIC_HOST');
  if (missing.length) {
    log.fail('ENV', `missing: ${missing.join(', ')}`);
    return false;
  }
  const e164 = /^\+[1-9]\d{7,14}$/;
  for (const [name, v] of [['TWILIO_PHONE_NUMBER', cfg.from], ['MY_VERIFIED_NUMBER', cfg.to]]) {
    if (!e164.test(v)) {
      log.fail('ENV', `${name} is not E.164 (needs to look like +12065550123)`);
      return false;
    }
  }
  log.stage('ENV', `azure=${new URL('https://' + cfg.azureEndpoint.replace(/^https?:\/\//, '')).host} deployment=${cfg.azureDeployment} port=${cfg.port} publicHost=${cfg.publicHost || '(unset)'}`);
  return true;
}
