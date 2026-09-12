// Dials MY_VERIFIED_NUMBER and nothing else. Refuses any other destination.
import twilioLib from 'twilio';
import { cfg, checkEnv } from './config.js';
import * as log from './log.js';

if (!checkEnv({ needPublicHost: true })) process.exit(1);

const to = process.argv[2] || cfg.to;
if (to !== cfg.to) {
  log.fail('CALL_CREATE', `refusing to dial ${to}. This build only calls MY_VERIFIED_NUMBER (${cfg.to}).`);
  process.exit(1);
}

const twimlUrl = `https://${cfg.publicHost}/twiml`;

// A stale tunnel host means Twilio reads an error message to whoever picks up.
const probe = await fetch(twimlUrl, { method: 'POST' }).catch((e) => ({ ok: false, status: e.message }));
const body = probe.ok ? await probe.text() : '';
if (!probe.ok || !body.includes('<Stream')) {
  log.fail('CALL_CREATE', `${twimlUrl} did not serve a <Stream> (${probe.status}). Not dialling.`);
  process.exit(1);
}
log.stage('TUNNEL', `${twimlUrl} verified`);

const client = twilioLib(cfg.twilioSid, cfg.twilioToken);
const call = await client.calls.create({
  to,
  from: cfg.from,
  url: twimlUrl,
  method: 'POST',
  statusCallback: `https://${cfg.publicHost}/status`,
  statusCallbackMethod: 'POST',
  statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  timeout: 25,
});

log.stage('CALL_CREATE', `sid=${call.sid} ${cfg.from} -> ${to} status=${call.status}`);
console.log('\nWatch the server window. Next stage you should see is TWILIO_FETCH_TWIML.');
