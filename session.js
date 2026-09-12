// One phone call, start to finish.
//
// This used to live inline in server.js, which was fine when a call was
// something a human started by hand. The queue needs to start a call, wait for
// it to finish, and be able to hang up on it, so a call has to be an object:
// it has a promise that settles with an outcome, and a way to cut it short.

import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { Realtime } from './realtime.js';
import { Playback } from './playback.js';
import { Findings } from './findings.js';
import { Transcript } from './transcript.js';
import { TOOLS, runTool } from './tools.js';
import { dtmfFrames, dtmfDurationMs } from './dtmf.js';
import { buildInstructions, buildGreeting } from './briefing.js';
import * as log from './log.js';

export class CallSession {
  constructor({ twilioWs, target = {}, onEvent = () => {} }) {
    this.ws = twilioWs;
    this.target = target;
    this.onEvent = onEvent;

    this.streamSid = null;
    this.callSid = null;
    this.framesIn = 0;
    this.framesOut = 0;
    this.audioGaps = 0;
    this.lastCallerAudio = Date.now();
    this.lastStreamMs = null;
    this.holdUntil = 0; // deliberate silence: on hold, or waiting for a menu

    this.closed = false;
    this.responsesInFlight = 0;
    this.hangupReason = null;
    this.hangupTimer = null;
    this.startedAt = Date.now();

    this.findings = new Findings();
    this.transcript = new Transcript({
      to: target.phone,
      company: target.name,
      onLine: (line) => this.onEvent({ type: 'line', callSid: this.callSid, line }),
    });

    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });

    this.#wire();
  }

  #wire() {
    this.playback = new Playback({
      onSettled: ({ text, totalMs, heardMs, heardFraction }) => {
        if (!text) return;
        const pct = Math.round(heardFraction * 100);
        // A turn only counts as something she said if the caller actually heard
        // some of it. A question that was cut off before it played is not a
        // question anyone can have answered.
        if (heardMs >= 150) this.findings.noteAgentTurn(text);
        this.transcript.agent(text, { heardFraction, heardMs, totalMs });
        if (pct >= 99) {
          log.info('caller heard', JSON.stringify(text));
        } else if (heardMs < 150) {
          log.warn('never heard', `${JSON.stringify(text)}  (cut off before any of it played)`);
        } else {
          log.warn('partly heard', `${pct}% played (${(heardMs / 1000).toFixed(1)}s of ${(totalMs / 1000).toFixed(1)}s): ${JSON.stringify(text)}`);
        }
      },
    });

    this.azure = new Realtime({
      instructions: buildInstructions(),
      tools: TOOLS,
      onToolCall: (name, args) => {
        const result = runTool(this.findings, name, args, {
          onEndCall: (r) => this.requestHangup(r),
          onPressKeys: (digits, why) => this.pressKeys(digits, why),
          onHold: (seconds, why) => this.holdFor(seconds, why),
        });
        this.transcript.tool(name, args, result);
        return result;
      },
      onCallerTranscript: (text) => {
        this.findings.noteCallerTurn(text);
        this.transcript.caller(text);
        if (String(text ?? '').trim()) this.heardAPerson = true;
      },
      onResponseStart: (id) => {
        this.responsesInFlight++;
        this.playback.startResponse(id);
      },
      onTranscript: (id, text, status) => {
        this.responsesInFlight = Math.max(0, this.responsesInFlight - 1);
        this.playback.endResponse(id, text, status);
      },
      onAudio: (b64, responseId) => {
        if (!this.streamSid || this.ws.readyState !== this.ws.OPEN) return;
        this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: b64 } }));
        this.framesOut++;
        const name = this.playback.queue(b64, responseId);
        this.ws.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name } }));
        log.once('TWILIO_AUDIO_OUT', `streamSid=${this.streamSid}`);
      },
      onBargeIn: () => {
        if (this.streamSid && this.ws.readyState === this.ws.OPEN) {
          this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
        }
        const dropped = this.playback.clear();
        if (dropped > 200) {
          log.warn('interrupted', `stopped talking, dropped ${(dropped / 1000).toFixed(1)}s of audio the caller never heard`);
        }
      },
      onClose: () => this.shutdown('azure closed'),
    });

    this.ws.on('message', (raw) => this.#onTwilioMessage(raw));
    this.ws.on('close', (code) => {
      log.stage('TWILIO_WS_CLOSE', `code=${code} framesIn=${this.framesIn} framesOut=${this.framesOut}`);
      this.shutdown('twilio socket closed');
    });
    this.ws.on('error', (err) => log.fail('TWILIO_WS', err.message));

    this.timer = setInterval(() => this.#tick(), 2000);
  }

  #tick() {
    const idleSec = (Date.now() - this.lastCallerAudio) / 1000;
    const totalSec = (Date.now() - this.startedAt) / 1000;

    if (totalSec > cfg.maxCallSeconds) return this.shutdown(`max call length ${cfg.maxCallSeconds}s`, 'too_long');

    // Nothing but silence since pickup. Not a person, or not one who is going
    // to talk to us. Counting seconds, not interpreting anything.
    //
    // Unless we are deliberately holding. A queue is silence on purpose, and
    // hanging up on "please wait for the next available agent" is exactly the
    // mistake this guard used to cause.
    if (!this.heardAPerson && totalSec > cfg.deadAirSeconds && Date.now() >= this.holdUntil) {
      log.warn('bad pickup', `${Math.round(totalSec)}s and nobody has said a word - hanging up`);
      this.findings.noteOutcome({ outcome: 'no_answer', summary: `nobody spoke in the first ${Math.round(totalSec)} seconds` });
      return this.requestHangup('no_one_there');
    }

    if (idleSec > cfg.idleHangupSeconds * 3) {
      this.shutdown(`no audio from phone for ${idleSec.toFixed(0)}s`, 'dropped');
    }
  }

  #onTwilioMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start':
        this.streamSid = msg.start.streamSid;
        this.callSid = msg.start.callSid;
        this.transcript.callSid = this.callSid;
        log.stage(
          'TWILIO_STREAM_START',
          `callSid=${this.callSid} streamSid=${this.streamSid} codec=${msg.start.mediaFormat?.encoding}@${msg.start.mediaFormat?.sampleRate}`,
        );
        this.onEvent({ type: 'connected', callSid: this.callSid });
        this.azure.connect();
        this.azure.speakFirst(buildGreeting());
        break;

      case 'media': {
        this.framesIn++;
        const streamMs = Number(msg.media?.timestamp);
        if (Number.isFinite(streamMs)) {
          if (this.lastStreamMs !== null) {
            const gap = streamMs - this.lastStreamMs;
            if (gap > 400) {
              this.audioGaps++;
              log.warn('audio gap', `${gap}ms with no frame from Twilio (gap #${this.audioGaps})`);
            }
          }
          this.lastStreamMs = streamMs;
        }
        this.lastCallerAudio = Date.now();
        log.once('CALLER_AUDIO_IN', `first frame, ${msg.media.payload.length} b64 chars`);
        // Once she has decided to hang up, stop feeding Azure. Otherwise every
        // "um" while she says goodbye starts another reply and the call never
        // actually ends.
        if (this.hangupReason) break;
        if (this.azure.appendAudio(msg.media.payload)) log.once('AZURE_AUDIO_IN');
        break;
      }

      case 'mark': {
        const lag = this.playback.confirmMark(msg.mark?.name);
        if (lag !== null) log.once('PLAYBACK_CONFIRMED', `first chunk reached the caller ${lag}ms after we sent it`);
        break;
      }

      case 'stop':
        log.info('twilio', 'stop frame');
        this.shutdown('twilio sent stop');
        break;

      default:
        break;
    }
  }

  // The agent asked to hang up. Her goodbye is still in Twilio's buffer, so
  // dropping now cuts her off. Wait until she has stopped generating and the
  // last chunk has actually played. The cap stops a stalled buffer holding the
  // line open forever.
  requestHangup(reason) {
    if (this.hangupReason) return;
    this.hangupReason = reason;
    const rude = reason === 'they_asked' || reason === 'hostile' || reason === 'no_one_there';
    log.info('hangup asked', `${reason}${rude ? ' - going now' : ' - after the goodbye plays'}`);
    this.transcript.event(`agent ended the call: ${reason}`);

    if (rude) {
      this.azure.cancelResponse();
      this.hangupTimer = setTimeout(() => this.shutdown(`agent ended the call: ${reason}`), 500);
      return;
    }

    const deadline = Date.now() + 20000;
    const tick = () => {
      if (this.closed) return;
      const backlog = this.playback.backlogMs;
      const busy = this.responsesInFlight > 0;
      if (!busy && backlog <= 0) return this.shutdown(`agent ended the call: ${reason}`);
      if (Date.now() > deadline) {
        log.warn('hangup', `waited 20s and ${busy ? 'she is still talking' : `${(backlog / 1000).toFixed(1)}s is still queued`} - going anyway`);
        return this.shutdown(`agent ended the call: ${reason}`);
      }
      this.hangupTimer = setTimeout(tick, 250);
    };
    this.hangupTimer = setTimeout(tick, 250);
  }

  // Press buttons on the keypad. The tones go out the same pipe as speech, so
  // anything she is mid-sentence about is cleared first - a menu listening for
  // a keypress should hear the keypress, not a sentence with a beep in it.
  pressKeys(digits, why) {
    if (!this.streamSid || this.ws.readyState !== this.ws.OPEN) return;

    this.azure.cancelResponse();
    this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    this.playback.clear();

    const frames = dtmfFrames(digits);
    for (const payload of frames) {
      this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload } }));
      this.framesOut++;
    }
    const ms = dtmfDurationMs(digits);
    // A menu that just took our keys is a live line, whatever the silence
    // meter thinks, so give it room to answer.
    this.holdFor(45, `waiting for the menu after pressing ${digits}`);
    log.stage('DTMF_SENT', `pressed ${digits} (${frames.length} frames, ${ms}ms)${why ? ` - ${why}` : ''}`);
    this.transcript.event(`pressed ${digits}${why ? ` - ${why}` : ''}`);
  }

  // Deliberately waiting. Holds off the silence-means-nobody-there guard for
  // as long as she asked for, and no longer.
  holdFor(seconds, why) {
    const until = Date.now() + seconds * 1000;
    if (until <= this.holdUntil) return;
    this.holdUntil = until;
    log.stage('ON_HOLD', `waiting ${seconds}s${why ? ` - ${why}` : ''}`);
    this.transcript.event(`waiting on hold for ${seconds}s${why ? ` - ${why}` : ''}`);
  }

  // Stop pressed. No waiting for a goodbye - the point of the red button is
  // that it happens now.
  hangUpNow(why = 'stopped from the control panel') {
    log.warn('stop', why);
    this.transcript.event(why);
    this.findings.noteHangup('stopped');
    this.shutdown(why, 'stopped');
  }

  #save() {
    const stem = `${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}-${this.callSid || 'nosid'}`;
    try {
      fs.mkdirSync('calls', { recursive: true });
      const record = {
        callSid: this.callSid,
        target: this.target,
        startedAt: new Date(this.startedAt).toISOString(),
        durationSeconds: Math.round((Date.now() - this.startedAt) / 1000),
        framesIn: this.framesIn,
        framesOut: this.framesOut,
        audioGaps: this.audioGaps,
        ...this.findings.toJSON(),
      };
      fs.writeFileSync(path.join('calls', `${stem}.json`), JSON.stringify(record, null, 2));
      log.info('saved', `calls/${stem}.json`);
    } catch (err) {
      log.warn('saved', `could not write the call notes: ${err.message}`);
    }
    this.transcript.save('calls', stem);
    return stem;
  }

  shutdown(why, forcedOutcome = null) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.hangupTimer) clearTimeout(this.hangupTimer);

    log.info('shutdown', `${why} framesIn=${this.framesIn} framesOut=${this.framesOut} audioGaps=${this.audioGaps}`);
    this.findings.print();
    const stem = this.#save();

    this.azure.close();
    try {
      this.ws.close();
    } catch {}

    const outcome =
      forcedOutcome || this.findings.outcome?.outcome || (this.heardAPerson ? 'ended' : 'no_answer');

    const result = {
      callSid: this.callSid,
      target: this.target,
      outcome,
      why,
      durationSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      spokeToAPerson: !!this.heardAPerson,
      findings: this.findings.toJSON(),
      files: stem,
    };
    this.onEvent({ type: 'finished', ...result });
    this.resolveDone(result);
  }
}
