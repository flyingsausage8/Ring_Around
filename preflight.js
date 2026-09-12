// Walks every hop except the phone itself. Run this before dialling anyone.
import { cfg, checkEnv, azureRealtimeUrl } from './config.js';
import { Realtime } from './realtime.js';
import { TOOLS } from './tools.js';
import * as log from './log.js';
import twilioLib from 'twilio';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  (ok ? log.info : log.fail)(name, detail);
}

async function checkLocal() {
  try {
    const r = await fetch(`http://localhost:${cfg.port}/health`);
    record('local server', r.ok, `http://localhost:${cfg.port}/health -> ${r.status}`);
    return r.ok;
  } catch (e) {
    record('local server', false, `not running (${e.message}) - start it with: npm start`);
    return false;
  }
}

async function checkTunnel() {
  if (!cfg.publicHost) {
    record('tunnel', false, 'PUBLIC_HOST is empty in .env');
    return false;
  }
  try {
    const r = await fetch(`https://${cfg.publicHost}/twiml`, { method: 'POST' });
    const body = await r.text();
    const ok = r.ok && body.includes('<Stream');
    record('tunnel', ok, ok ? `https://${cfg.publicHost}/twiml serves a <Stream>` : `HTTP ${r.status}: ${body.slice(0, 200)}`);
    if (ok) log.stage('TUNNEL', `https://${cfg.publicHost} reaches this machine`);
    return ok;
  } catch (e) {
    record('tunnel', false, `${cfg.publicHost} unreachable: ${e.message}`);
    return false;
  }
}

async function checkTwilio() {
  try {
    const client = twilioLib(cfg.twilioSid, cfg.twilioToken);
    const acct = await client.api.accounts(cfg.twilioSid).fetch();
    record('twilio auth', acct.status === 'active', `account ${acct.friendlyName} status=${acct.status}`);

    const nums = await client.incomingPhoneNumbers.list({ phoneNumber: cfg.from, limit: 1 });
    record('twilio number', nums.length > 0, nums.length ? `${cfg.from} is owned by this account` : `${cfg.from} is not on this account`);

    if (acct.type === 'Trial') {
      const ok = (await client.outgoingCallerIds.list({ phoneNumber: cfg.to, limit: 1 })).length > 0;
      record('verified callee', ok, ok ? `${cfg.to} is a verified caller ID` : `trial account cannot dial ${cfg.to} until it is verified`);
    }
    return true;
  } catch (e) {
    record('twilio auth', false, e.message);
    return false;
  }
}

function checkAzure() {
  return new Promise((resolve) => {
    log.info('azure url', azureRealtimeUrl());
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      record('azure realtime', ok, detail);
      rt.close();
      resolve(ok);
    };
    // Send the real tool schemas, not an empty list. If Azure rejects one of
    // them, this is where we want to find out - not thirty seconds into a call
    // with a contractor who is about to give us a price.
    const rt = new Realtime({ instructions: 'preflight', tools: TOOLS, onClose: () => done(false, 'socket closed before session.updated') });
    rt.connect();
    rt.whenReady(() => done(true, `session accepted audio/pcmu + semantic_vad + ${TOOLS.length} tools`));
    setTimeout(() => done(false, 'timed out after 15s'), 15000);
  });
}

const args = process.argv.slice(2);
const skipLocal = args.includes('--azure-only');

if (!checkEnv()) process.exit(1);

if (skipLocal) {
  await checkAzure();
} else {
  const up = await checkLocal();
  if (up) await checkTunnel();
  await checkTwilio();
  await checkAzure();
}

const bad = results.filter((r) => !r.ok);
console.log('');
console.log(bad.length ? `PREFLIGHT FAILED: ${bad.map((r) => r.name).join(', ')}` : 'PREFLIGHT OK - safe to dial');
process.exit(bad.length ? 1 : 0);
