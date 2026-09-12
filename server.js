import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { cfg, checkEnv } from './config.js';
import { CallSession } from './session.js';
import { CallQueue } from './queue.js';
import { makeDialer, claimPending, assertReachable } from './dialer.js';
import { discover, loadFixture, rank } from './discovery.js';
import * as log from './log.js';

if (!checkEnv()) process.exit(1);

// Everyone watching the portal. A call is happening in real time, so the page
// should not have to keep asking "anything yet?" - the server tells it.
const watchers = new Set();

// Call SIDs we have seen a real ringing signal for.
const rang = new Set();

// The call on the line right now, so a late verdict from Twilio can reach it.
let liveSession = null;

// Twilio is told to make its mind up within 5 seconds. Anything arriving well
// after that is not a verdict about who picked up the phone.
const AMD_VERDICT_GOOD_FOR_SEC = 15;

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of watchers) {
    try {
      res.write(frame);
    } catch {
      watchers.delete(res);
    }
  }
}

const queue = new CallQueue({ dialer: makeDialer(), onChange: () => broadcast('queue', statusPayload()) });
const phoneQueue = new CallQueue({
  dialer: makeDialer({ toOverride: cfg.to }),
  onChange: () => broadcast('queue', statusPayload()),
});

// There are two queues and only one page. A bare "here is a queue" event
// cannot say WHICH queue it came from, so an idle one would overwrite a
// running one and the page would show every shop stuck on "waiting". Both
// queues therefore report the same full picture, identical to /api/status, so
// there is exactly one way to read the state.
function statusPayload() {
  return {
    contractors: queue.status(),
    phone: phoneQueue.status(),
    publicHost: cfg.publicHost || null,
  };
}

// Which of the two is allowed to own the line. Only ever one - the whole
// point of this design is that two calls never happen at once.
function activeQueue() {
  if (queue.running) return queue;
  if (phoneQueue.running) return phoneQueue;
  return null;
}

function twiml() {
  const url = `wss://${cfg.publicHost}/media`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${url}" />
  </Connect>
</Response>`;
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendFile(res, name) {
  const file = path.join(process.cwd(), name);
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    return res.end(`${name} missing`);
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  return res.end(fs.readFileSync(file));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const route = req.url.split('?')[0];

  if (route === '/health') {
    return json(res, 200, { ok: true, publicHost: cfg.publicHost || null });
  }

  if (route === '/' || route === '/portal') {
    return sendFile(res, 'portal.html');
  }

  if (route === '/panel') {
    return sendFile(res, 'panel.html');
  }

  // The live feed. One long-lived response, one line per thing that happens.
  if (route === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': hello\n\n');
    watchers.add(res);
    res.write(`event: queue\ndata: ${JSON.stringify(statusPayload())}\n\n`);
    // Some proxies close a stream that says nothing for a while.
    const beat = setInterval(() => {
      try {
        res.write(': beat\n\n');
      } catch {}
    }, 15000);
    req.on('close', () => {
      clearInterval(beat);
      watchers.delete(res);
    });
    return;
  }

  // The job the agent is calling about, so the portal does not have to
  // hard-code what is already in the config.
  if (route === '/api/job') {
    return json(res, 200, { job: cfg.job, agent: cfg.agentName, myNumber: cfg.to });
  }

  // Every call that has ever finished, rebuilt from disk. The queues only
  // remember the current run, so without this a restart makes real calls -
  // transcripts, prices, booked slots - vanish from the page while sitting
  // safely in calls/. Shaped like queue rows so the portal draws them the
  // same way.
  if (route === '/api/history') {
    const dir = path.join(process.cwd(), 'calls');
    if (!fs.existsSync(dir)) return json(res, 200, { ok: true, calls: [] });
    const calls = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name.endsWith('.transcript.json')) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        calls.push({
          name: r.target?.name || 'unknown',
          phone: r.target?.phone || '',
          status: 'done',
          outcome: r.outcome?.outcome || (r.hangup ? r.hangup.reason : null) || 'ended',
          durationSeconds: r.durationSeconds ?? null,
          error: null,
          files: name.slice(0, -5),
          startedAt: r.startedAt || null,
          findings: r,
        });
      } catch {
        // A half-written file from a crash is not worth failing the page over.
      }
    }
    calls.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return json(res, 200, { ok: true, calls });
  }

  if (route === '/api/transcript') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return json(res, 400, { ok: false, error: 'bad transcript id' });
    const file = path.join(process.cwd(), 'calls', `${id}.transcript.json`);
    if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'no transcript saved for that call' });
    try {
      return json(res, 200, { ok: true, transcript: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch (err) {
      return json(res, 500, { ok: false, error: `could not read the transcript: ${err.message}` });
    }
  }

  if (route === '/twiml') {
    log.stage('TWILIO_FETCH_TWIML', `${req.method} from ${req.socket.remoteAddress}`);
    if (!cfg.publicHost) {
      log.fail('TWIML_SENT', 'PUBLIC_HOST is empty - Twilio would dial wss://undefined/media');
      res.writeHead(500);
      return res.end('PUBLIC_HOST not set');
    }
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(twiml());
    log.stage('TWIML_SENT', `stream -> wss://${cfg.publicHost}/media`);
    return;
  }

  if (route === '/status') {
    const body = await new Promise((r) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => r(b));
    });
    const p = new URLSearchParams(body);
    const status = p.get('CallStatus');
    log.info('twilio status', `${status} sid=${p.get('CallSid')} ${p.get('ErrorCode') ? 'err=' + p.get('ErrorCode') : ''}`);

    // A call that is answered without ever ringing was not answered by the
    // person we dialled - it was intercepted by voicemail or a screening
    // service. Worth saying out loud, because from inside everything else
    // looks perfectly healthy.
    if (status === 'ringing') rang.add(p.get('CallSid'));
    if (status === 'in-progress' && !rang.has(p.get('CallSid'))) {
      log.warn('twilio', 'answered without ever ringing - voicemail or call screening picked this up, not a person');
    }
    if (status === 'completed') rang.delete(p.get('CallSid'));

    res.writeHead(204);
    return res.end();
  }

  // Twilio's verdict on who picked up. It arrives a few seconds into the call,
  // separately from everything else.
  if (route === '/amd') {
    const body = await new Promise((r) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => r(b));
    });
    const p = new URLSearchParams(body);
    const who = p.get('AnsweredBy');
    log.stage('AMD', `${who} sid=${p.get('CallSid')}`);
    const s = liveSession;
    if (s && who && who !== 'human' && who !== 'unknown') {
      // Twilio is asked to decide within 5 seconds (see dialer.js), so a
      // verdict cannot normally arrive late. If one ever does - a setting
      // drifts, Twilio changes its timing - it is about the first moments of
      // the call and says nothing about a conversation that has been running
      // for half a minute. Reading a clock, nothing else.
      const age = Math.round((Date.now() - s.startedAt) / 1000);
      if (age > AMD_VERDICT_GOOD_FOR_SEC) {
        log.warn('amd', `${who} arrived ${age}s in - too late to be about who picked up, ignoring it`);
      } else {
        log.warn('amd', `${who} answered - hanging up rather than talking to a machine`);
        s.findings.noteBadPickup(who === 'fax' ? 'no_one_there' : 'voicemail', `Twilio heard ${who}`);
        s.requestHangup('no_one_there');
      }
    }
    res.writeHead(204);
    return res.end();
  }

  // ---- control panel API ----

  if (route === '/api/status') {
    return json(res, 200, statusPayload());
  }

  // Find companies to call, but do not call anybody. Looking and dialling are
  // two separate buttons on purpose.
  if (route === '/api/discover' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const source = body.source === 'fixture' ? 'fixture' : 'places';
      const list = source === 'fixture' ? rank(loadFixture()) : await discover({ ...body, source: 'places' });
      broadcast('contractors', { source, contractors: list });
      return json(res, 200, { ok: true, source, contractors: list });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (route === '/api/start' && req.method === 'POST') {
    const body = await readBody(req);
    const phoneMode = body.mode === 'phone';
    const q = phoneMode ? phoneQueue : queue;
    if (activeQueue()) return json(res, 409, { ok: false, error: 'a call is already running' });

    try {
      let targets = body.targets;
      if (phoneMode) {
        // One call, to my own number, no matter what the browser sent.
        targets = [{ name: 'my phone', phone: cfg.to, phoneSource: 'manual' }];
      }
      if (!Array.isArray(targets) || !targets.length) {
        return json(res, 400, { ok: false, error: 'no targets - run discovery first' });
      }

      // Tell them now, not after the phone has rung out. A dead tunnel means
      // the caller hears "an application error has occurred", which looks like
      // the agent is broken when the real problem is out here.
      await assertReachable();

      q.load(targets, { mode: phoneMode ? 'phone' : 'contractors' });
      q.start().catch((err) => log.fail('QUEUE_START', err.message));
      return json(res, 200, { ok: true, status: q.status() });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  }

  if (route === '/api/pause' && req.method === 'POST') {
    const q = activeQueue();
    if (!q) return json(res, 200, { ok: true, note: 'nothing running' });
    return json(res, 200, { ok: true, status: q.pause() });
  }

  if (route === '/api/stop' && req.method === 'POST') {
    const q = activeQueue();
    if (!q) return json(res, 200, { ok: true, note: 'nothing running' });
    return json(res, 200, { ok: true, status: q.stop('stop pressed') });
  }

  if (route === '/api/resume' && req.method === 'POST') {
    const q = queue.items.some((x) => x.status === 'waiting') ? queue : phoneQueue;
    if (activeQueue()) return json(res, 409, { ok: false, error: 'already running' });
    try {
      q.resume().catch((err) => log.fail('QUEUE_START', err.message));
      return json(res, 200, { ok: true, status: q.status() });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  }

  res.writeHead(404);
  res.end('no');
});

const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (twilioWs, req) => {
  log.resetOnce();
  log.stage('TWILIO_WS_OPEN', `from ${req.socket.remoteAddress}`);

  const q = activeQueue();
  const target = q?.current ? { name: q.current.name, phone: q.current.phone } : { name: 'unqueued call', phone: cfg.to };

  const session = new CallSession({
    twilioWs,
    target,
    onEvent: (e) => {
      if (e.type === 'finished' && liveSession === session) liveSession = null;
      broadcast(e.type === 'line' ? 'line' : 'call', e);
    },
  });
  liveSession = session;

  // Hand the live call to whoever dialled it. If nothing was waiting, this is
  // a call somebody started by hand - it still runs, it just is not in a list.
  if (!claimPending(session)) {
    log.warn('media', 'a call arrived that the queue did not dial - running it standalone');
  }
});

server.listen(cfg.port, () => {
  log.stage('HTTP_LISTEN', `http://localhost:${cfg.port}  (panel at / , also /twiml /media /health /status /api/*)`);
});
