import WebSocket from 'ws';
import { cfg, azureRealtimeUrl } from './config.js';
import * as log from './log.js';

// Twilio media streams are 8 kHz mu-law, which Azure calls audio/pcmu.
// Same codec on both sides means zero transcoding in the relay.
const PCMU = { type: 'audio/pcmu' };

export class Realtime {
  constructor({ tag = 'azure', instructions = '', onAudio, onBargeIn, onClose } = {}) {
    this.tag = tag;
    this.instructions = instructions;
    this.onAudio = onAudio || (() => {});
    this.onBargeIn = onBargeIn || (() => {});
    this.onClose = onClose || (() => {});
    this.ws = null;
    this.ready = false;
    this.queued = [];
  }

  connect() {
    const url = azureRealtimeUrl();
    log.stage('AZURE_WS_CONNECT', `${url}`);
    this.ws = new WebSocket(url, {
      headers: {
        'api-key': cfg.azureKey,
        Authorization: `Bearer ${cfg.azureKey}`,
      },
    });

    this.ws.on('unexpected-response', (_req, res) => {
      log.fail('AZURE_WS', `handshake HTTP ${res.statusCode} ${res.statusMessage}`);
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => body && log.fail('AZURE_WS', `body: ${body.slice(0, 300)}`));
    });

    this.ws.on('open', () => {
      log.stage('AZURE_WS_OPEN');
      this.#sendSession();
    });

    this.ws.on('message', (raw) => this.#onMessage(raw));

    this.ws.on('error', (err) => log.fail('AZURE_WS', err.message));

    this.ws.on('close', (code, reason) => {
      log.stage('AZURE_WS_CLOSE', `code=${code} ${reason?.toString().slice(0, 200) || ''}`);
      this.onClose();
    });

    return this;
  }

  #sendSession() {
    this.#raw({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: PCMU,
            // Whisper on phone audio will wander into other languages if you
            // let it guess, and then the agent follows it there.
            transcription: { model: 'whisper-1', language: 'en' },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: cfg.eagerness,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { format: PCMU, voice: cfg.voice, speed: cfg.speed },
        },
      },
    });
    log.stage('AZURE_SESSION_SENT', `voice=${cfg.voice} format=audio/pcmu vad=semantic`);
  }

  #onMessage(raw) {
    let ev;
    try {
      ev = JSON.parse(raw.toString());
    } catch {
      return log.warn('AZURE_WS', 'non-JSON frame');
    }

    switch (ev.type) {
      case 'session.created':
        log.info('azure', `session.created id=${ev.session?.id || '?'}`);
        break;

      case 'session.updated':
        if (!this.ready) {
          this.ready = true;
          log.stage('AZURE_SESSION_READY');
          for (const fn of this.queued.splice(0)) fn();
        }
        break;

      // GA calls it response.output_audio.delta, preview called it
      // response.audio.delta. Accept both so an api-version bump can't mute us.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        log.once('AZURE_AUDIO_OUT', `${ev.delta?.length || 0} b64 chars`);
        this.onAudio(ev.delta);
        break;

      case 'input_audio_buffer.speech_started':
        log.info('azure', 'caller started talking -> barge in');
        this.onBargeIn();
        break;

      case 'conversation.item.input_audio_transcription.completed':
        log.info('caller said', JSON.stringify(ev.transcript));
        break;

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        log.info('agent said', JSON.stringify(ev.transcript));
        break;

      case 'response.done': {
        const status = ev.response?.status;
        if (status && status !== 'completed') {
          log.warn('azure', `response ${status}: ${JSON.stringify(ev.response?.status_details || {}).slice(0, 300)}`);
        }
        break;
      }

      case 'error':
        log.fail('AZURE_EVENT', JSON.stringify(ev.error || ev).slice(0, 500));
        break;

      default:
        break;
    }
  }

  #raw(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  whenReady(fn) {
    if (this.ready) fn();
    else this.queued.push(fn);
  }

  appendAudio(b64) {
    if (!this.ready) return false;
    this.#raw({ type: 'input_audio_buffer.append', audio: b64 });
    return true;
  }

  speakFirst(prompt) {
    this.whenReady(() => {
      this.#raw({ type: 'response.create', response: { instructions: prompt } });
      log.stage('AGENT_GREET', JSON.stringify(prompt).slice(0, 120));
    });
  }

  cancelResponse() {
    this.#raw({ type: 'response.cancel' });
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}
