// One line per stage boundary. If a call dies, the last STAGE line printed
// tells you which hop failed, so nobody has to guess.

const t0 = Date.now();

function stamp() {
  const ms = Date.now() - t0;
  const s = (ms / 1000).toFixed(2).padStart(7, ' ');
  return `[+${s}s]`;
}

// Every boundary in the system, in the order a healthy call walks through them.
// Anything not on this list is not a boundary, it is detail - use log.info.
export const STAGES = [
  'ENV',                  // config loaded and sane
  'HTTP_LISTEN',          // our server is up
  'TUNNEL',               // public host answers
  'CALL_CREATE',          // we asked Twilio to dial
  'TWILIO_FETCH_TWIML',   // Twilio asked us what to say
  'TWIML_SENT',           // we answered with a <Stream>
  'TWILIO_WS_OPEN',       // Twilio opened the media socket
  'TWILIO_STREAM_START',  // Twilio sent the start frame
  'AZURE_WS_CONNECT',     // we dialled Azure
  'AZURE_WS_OPEN',        // Azure accepted the socket
  'AZURE_SESSION_SENT',   // we configured the session
  'AZURE_SESSION_READY',  // Azure confirmed the session
  'AGENT_GREET',          // we asked the agent to speak first
  'CALLER_AUDIO_IN',      // first audio from the phone
  'AZURE_AUDIO_IN',       // first audio appended to Azure
  'AZURE_AUDIO_OUT',      // first audio back from Azure
  'TWILIO_AUDIO_OUT',     // first audio pushed to the phone
  'TWILIO_WS_CLOSE',      // phone side hung up
  'AZURE_WS_CLOSE',       // agent side closed
];

function line(kind, colorless, ...rest) {
  console.log(`${stamp()} ${colorless}`, ...rest);
}

export function stage(name, detail = '') {
  if (!STAGES.includes(name)) throw new Error(`unknown stage: ${name}`);
  line('stage', `STAGE ${name.padEnd(20)} ${detail}`);
}

export function info(where, detail = '') {
  line('info', `      ${where.padEnd(20)} ${detail}`);
}

export function warn(where, detail = '') {
  line('warn', `WARN  ${where.padEnd(20)} ${detail}`);
}

export function fail(where, detail = '') {
  line('fail', `FAIL  ${where.padEnd(20)} ${detail}`);
}

// Fires once per key, so "first audio frame" boundaries stay one line each
// instead of 3000.
const seen = new Set();
export function once(name, detail = '') {
  if (seen.has(name)) return false;
  seen.add(name);
  stage(name, detail);
  return true;
}

export function resetOnce(prefix = '') {
  for (const k of [...seen]) if (!prefix || k.startsWith(prefix)) seen.delete(k);
}
