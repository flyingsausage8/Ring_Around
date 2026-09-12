import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { cfg, checkEnv } from './config.js';
import { CallSession } from './session.js';
import { CallQueue } from './queue.js';
import { makeDialer, claimPending } from './dialer.js';
import { discover, loadFixture, rank } from './discovery.js';
import * as log from './log.js';

if (!checkEnv()) process.exit(1);

const queue = new CallQueue({ dialer: makeDialer() });
const phoneQueue = new CallQueue({ dialer: makeDialer({ toOverride: cfg.to }) });

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

  if (route === '/' || route === '/panel') {
    const file = path.join(process.cwd(), 'panel.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('panel.html missing');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(fs.readFileSync(file));
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
    log.info('twilio status', `${p.get('CallStatus')} sid=${p.get('CallSid')} ${p.get('ErrorCode') ? 'err=' + p.get('ErrorCode') : ''}`);
    res.writeHead(204);
    return res.end();
  }

  // ---- control panel API ----

  if (route === '/api/status') {
    return json(res, 200, {
      contractors: queue.status(),
      phone: phoneQueue.status(),
      publicHost: cfg.publicHost || null,
    });
  }

  // Find companies to call, but do not call anybody. Looking and dialling are
  // two separate buttons on purpose.
  if (route === '/api/discover' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const source = body.source === 'fixture' ? 'fixture' : 'places';
      const list = source === 'fixture' ? rank(loadFixture()) : await discover({ ...body, source: 'places' });
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

  const session = new CallSession({ twilioWs, target });

  // Hand the live call to whoever dialled it. If nothing was waiting, this is
  // a call somebody started by hand - it still runs, it just is not in a list.
  if (!claimPending(session)) {
    log.warn('media', 'a call arrived that the queue did not dial - running it standalone');
  }
});

server.listen(cfg.port, () => {
  log.stage('HTTP_LISTEN', `http://localhost:${cfg.port}  (panel at / , also /twiml /media /health /status /api/*)`);
});
