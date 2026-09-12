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
  eagerness: process.env.AGENT_EAGERNESS || 'auto',
  speed: Number(process.env.AGENT_SPEED || 1),
  temperature: Number(process.env.AGENT_TEMPERATURE || 0.8),
  idleHangupSeconds: Number(process.env.IDLE_HANGUP_SECONDS || 20),
  maxCallSeconds: Number(process.env.MAX_CALL_SECONDS || 180),
  // How long we will sit on a line where nobody has said a word. Long enough
  // for a slow "hello?", short enough not to talk at an empty room.
  deadAirSeconds: Number(process.env.DEAD_AIR_SECONDS || 25),
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
    address: process.env.JOB_ADDRESS || '',
    phone: process.env.JOB_PHONE || '',
    availability: process.env.JOB_AVAILABILITY || 'most weekday afternoons',
    issue: process.env.JOB_ISSUE || 'an appliance that has stopped working',
    brand: process.env.JOB_BRAND || '',
    fuel: process.env.JOB_FUEL || '',
    age: process.env.JOB_AGE || '',
    errorCode: process.env.JOB_ERROR_CODE || '',
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
