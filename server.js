import http from 'node:http';
import { WebSocketServer } from 'ws';
import { cfg, checkEnv } from './config.js';
import { Realtime } from './realtime.js';
import { Playback } from './playback.js';
import { INSTRUCTIONS, GREETING } from './briefing.js';
import * as log from './log.js';

if (!checkEnv()) process.exit(1);

function twiml() {
  const url = `wss://${cfg.publicHost}/media`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${url}" />
  </Connect>
</Response>`;
}

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];

  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, publicHost: cfg.publicHost || null }));
  }

  if (path === '/twiml') {
    log.stage('TWILIO_FETCH_TWIML', `${req.method} from ${req.socket.remoteAddress}`);
    if (!cfg.publicHost) {
      log.fail('TWIML_SENT', 'PUBLIC_HOST is empty - Twilio would dial wss://undefined/media');
      res.writeHead(500);
      return res.end('PUBLIC_HOST not set');
    }
    const body = twiml();
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(body);
    log.stage('TWIML_SENT', `stream -> wss://${cfg.publicHost}/media`);
    return;
  }

  if (path === '/status') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      log.info('twilio status', `${p.get('CallStatus')} sid=${p.get('CallSid')} ${p.get('ErrorCode') ? 'err=' + p.get('ErrorCode') : ''}`);
      res.writeHead(204);
      res.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('no');
});

const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (twilioWs, req) => {
  log.resetOnce();
  log.stage('TWILIO_WS_OPEN', `from ${req.socket.remoteAddress}`);

  let streamSid = null;
  let callSid = null;
  let framesIn = 0;
  let framesOut = 0;
  let audioGaps = 0;
  let lastCallerAudio = Date.now();
  let lastStreamMs = null;
  let closed = false;

  const playback = new Playback({
    onSettled: ({ text, totalMs, heardMs, heardFraction }) => {
      if (!text) return;
      const pct = Math.round(heardFraction * 100);
      if (pct >= 99) {
        log.info('caller heard', JSON.stringify(text));
      } else if (heardMs < 150) {
        log.warn('never heard', `${JSON.stringify(text)}  (cut off before any of it played)`);
      } else {
        log.warn('partly heard', `${pct}% played (${(heardMs / 1000).toFixed(1)}s of ${(totalMs / 1000).toFixed(1)}s): ${JSON.stringify(text)}`);
      }
    },
  });

  const azure = new Realtime({
    instructions: INSTRUCTIONS,
    onResponseStart: (id) => playback.startResponse(id),
    onTranscript: (id, text, status) => playback.endResponse(id, text, status),
    onAudio: (b64, responseId) => {
      if (!streamSid || twilioWs.readyState !== twilioWs.OPEN) return;
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
      framesOut++;
      // Twilio echoes this mark back once the chunk has actually finished
      // playing to the caller. That echo is the only honest signal we get.
      const name = playback.queue(b64, responseId);
      twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name } }));
      log.once('TWILIO_AUDIO_OUT', `streamSid=${streamSid}`);
    },
    onBargeIn: () => {
      if (streamSid && twilioWs.readyState === twilioWs.OPEN) {
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      }
      const dropped = playback.clear();
      if (dropped > 200) {
        log.warn('barge-in', `dropped ${(dropped / 1000).toFixed(1)}s of audio the caller never heard`);
      }
    },
    onClose: () => shutdown('azure closed'),
  });

  function shutdown(why) {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    log.info('shutdown', `${why} framesIn=${framesIn} framesOut=${framesOut} audioGaps=${audioGaps}`);
    azure.close();
    try {
      twilioWs.close();
    } catch {}
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const idle = (Date.now() - lastCallerAudio) / 1000;
    const total = (Date.now() - startedAt) / 1000;
    if (total > cfg.maxCallSeconds) shutdown(`max call length ${cfg.maxCallSeconds}s`);
    else if (idle > cfg.idleHangupSeconds * 3) shutdown(`no audio from phone for ${idle.toFixed(0)}s`);
  }, 2000);

  twilioWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        log.stage('TWILIO_STREAM_START', `callSid=${callSid} streamSid=${streamSid} codec=${msg.start.mediaFormat?.encoding}@${msg.start.mediaFormat?.sampleRate}`);
        azure.connect();
        azure.speakFirst(GREETING);
        break;

      case 'media': {
        framesIn++;
        const now = Date.now();
        // Twilio stamps every frame with ms since the stream started. That is
        // the call's own clock, so gaps in it are real gaps on the line
        // rather than this process being busy.
        const streamMs = Number(msg.media?.timestamp);
        if (Number.isFinite(streamMs)) {
          if (lastStreamMs !== null) {
            const gap = streamMs - lastStreamMs;
            if (gap > 400) {
              audioGaps++;
              log.warn('audio gap', `${gap}ms with no frame from Twilio (gap #${audioGaps})`);
            }
          }
          lastStreamMs = streamMs;
        }
        lastCallerAudio = now;
        log.once('CALLER_AUDIO_IN', `first frame, ${msg.media.payload.length} b64 chars`);
        if (azure.appendAudio(msg.media.payload)) log.once('AZURE_AUDIO_IN');
        break;
      }

      // Twilio finished playing a chunk to the caller. This is the only
      // event that tells us what was actually heard.
      case 'mark': {
        const lag = playback.confirmMark(msg.mark?.name);
        if (lag !== null && log.once('PLAYBACK_CONFIRMED', `first chunk reached the caller ${lag}ms after we sent it`)) break;
        break;
      }

      case 'stop':
        log.info('twilio', 'stop frame');
        shutdown('twilio sent stop');
        break;

      default:
        break;
    }
  });

  twilioWs.on('close', (code) => {
    log.stage('TWILIO_WS_CLOSE', `code=${code} framesIn=${framesIn} framesOut=${framesOut}`);
    shutdown('twilio socket closed');
  });

  twilioWs.on('error', (err) => log.fail('TWILIO_WS', err.message));
});

server.listen(cfg.port, () => {
  log.stage('HTTP_LISTEN', `http://localhost:${cfg.port}  (/twiml /media /health /status)`);
});
