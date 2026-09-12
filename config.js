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

  // The demo job the agent is calling about. Placeholder until discovery
  // feeds real jobs in.
  job: {
    client: process.env.JOB_CLIENT || 'the client',
    address: process.env.JOB_ADDRESS || 'an address in the area',
    phone: process.env.JOB_PHONE || 'a number I can share',
    availability: process.env.JOB_AVAILABILITY || 'most weekday afternoons',
    issue: process.env.JOB_ISSUE || 'a fridge that has stopped cooling properly',
  },
};

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
