import WebSocket from 'ws';
import { cfg, azureRealtimeUrl } from './config.js';
import * as log from './log.js';

// Twilio media streams are 8 kHz mu-law, which Azure calls audio/pcmu.
// Same codec on both sides means zero transcoding in the relay.
const PCMU = { type: 'audio/pcmu' };

export class Realtime {
  constructor({ tag = 'azure', instructions = '', tools = [], onToolCall, onAudio, onBargeIn, onClose, onResponseStart, onTranscript } = {}) {
    this.tag = tag;
    this.instructions = instructions;
    this.tools = tools;
    this.onToolCall = onToolCall || (() => ({ ok: false, error: 'no tool handler wired' }));
    this.onAudio = onAudio || (() => {});
    this.onBargeIn = onBargeIn || (() => {});
    this.onClose = onClose || (() => {});
    this.onResponseStart = onResponseStart || (() => {});
    this.onTranscript = onTranscript || (() => {});
    this.ws = null;
    this.ready = false;
    this.queued = [];
    this.speechStoppedAt = null;
    this.latencyLogged = false;
    this.greetingPrompt = null;
    this.greetingPending = false;
    this.greetingAttempts = 0;
    this.greetingResponseId = null;
    this.awaitingGreetingId = false;
    this.audioFramesThisResponse = 0;
    this.currentResponseId = null;
    this.pendingTranscript = null;
    this.toolFollowUp = false;   // a tool ran, so the model owes us a reply
    this.toolCallsThisResponse = 0;
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

    this.ws.on('message', (raw) => {
      let ev;
      try {
        ev = JSON.parse(raw.toString());
      } catch {
        return log.warn('AZURE_WS', 'non-JSON frame');
      }
      this.onAzureEvent(ev);
    });

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
        tools: this.tools,
        tool_choice: 'auto',
      },
    });
    log.stage('AZURE_SESSION_SENT', `voice=${cfg.voice} format=audio/pcmu vad=semantic tools=${this.tools.length}`);
  }

  // Public so tests can drive it with fake events. Takes a parsed event.
  onAzureEvent(ev) {
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

      case 'response.created':
        this.audioFramesThisResponse = 0;
        this.toolCallsThisResponse = 0;
        this.currentResponseId = ev.response?.id || null;
        this.onResponseStart(this.currentResponseId);
        // Tie the retry logic to this exact response id, so a reply triggered
        // by the caller talking can never be mistaken for the greeting.
        if (this.awaitingGreetingId) {
          this.greetingResponseId = ev.response?.id || null;
          this.awaitingGreetingId = false;
        }
        break;

      // GA calls it response.output_audio.delta, preview called it
      // response.audio.delta. Accept both so an api-version bump can't mute us.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.audioFramesThisResponse++;
        log.once('AZURE_AUDIO_OUT', `${ev.delta?.length || 0} b64 chars`);
        if (this.speechStoppedAt && !this.latencyLogged) {
          this.latencyLogged = true;
          const ms = Date.now() - this.speechStoppedAt;
          const verdict = ms < 800 ? 'snappy' : ms < 1500 ? 'ok' : 'SLOW - caller will notice';
          log.info('reply latency', `${ms}ms (${verdict})`);
        }
        this.onAudio(ev.delta, this.currentResponseId);
        break;

      // The model has decided to write something down. Run it, hand the result
      // straight back, but do NOT ask for a reply yet - there is still a
      // response in flight and Azure allows only one at a time.
      case 'response.function_call_arguments.done':
      case 'response.function_call_arguments.delta':
        if (ev.type.endsWith('.delta')) break;
        this.#handleToolCall(ev);
        break;

      case 'input_audio_buffer.speech_started':
        // Sound started, but that is not the same as an interruption. Let
        // semantic VAD decide whether this is a real turn or just a "mm-hm" -
        // if we dropped the buffer here, every backchannel would punch a hole
        // in the middle of her sentence. The cancel below is the real signal.
        log.info('azure', 'caller audio started');
        this.speechStoppedAt = null;
        break;

      // Time from "caller stopped talking" to "first audio of the reply" is
      // the number the person on the phone actually feels. Anything past a
      // second or so and they start saying "hello?".
      case 'input_audio_buffer.speech_stopped':
        this.speechStoppedAt = Date.now();
        this.latencyLogged = false;
        break;

      case 'conversation.item.input_audio_transcription.completed':
        log.info('caller said', JSON.stringify(ev.transcript));
        break;

      // What the model produced. NOT what the caller heard - that only becomes
      // known once Twilio marks the audio as played. See playback.js.
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.pendingTranscript = ev.transcript;
        break;

      case 'response.done': {
        const status = ev.response?.status;
        const cancelled = status === 'cancelled';
        const isGreeting = this.greetingPending && ev.response?.id === this.greetingResponseId;

        // The greeting carries the AI disclosure, so it is the one turn that
        // must not get eaten. Line noise at pickup can trip the VAD before a
        // single word is out - when that happens the reply is cancelled with
        // zero audio produced, so say it again. Only counts audio frames and
        // compares ids, never inspects what anyone said.
        if (isGreeting && cancelled && this.audioFramesThisResponse === 0) {
          this.greetingAttempts++;
          if (this.greetingAttempts <= 2) {
            log.warn('greeting', `cancelled before any audio (attempt ${this.greetingAttempts}) - saying it again`);
            setTimeout(() => this.#createGreeting(), 400);
          } else {
            log.fail('greeting', 'cancelled 3 times - giving up, disclosure may not have been heard');
            this.greetingPending = false;
          }
        } else if (isGreeting && this.audioFramesThisResponse > 0) {
          this.greetingPending = false;
          log.info('greeting', 'delivered');
        }

        if (status && status !== 'completed') {
          log.warn('azure', `response ${status}: ${JSON.stringify(ev.response?.status_details || {}).slice(0, 300)}`);
        }
        // Azure has judged this a genuine interruption and stopped generating.
        // Now, and only now, drop whatever is still queued on the phone -
        // otherwise she keeps talking out of Twilio's buffer after she has
        // stopped being produced.
        if (cancelled) this.onBargeIn();
        this.onTranscript(ev.response?.id || null, this.pendingTranscript ?? '', status);
        this.pendingTranscript = null;

        // A tool ran during that response. The slot may have been refused, or
        // the price may be over budget, and she needs to say so out loud. Now
        // that the response is finished, it is safe to ask for another.
        // Skipped when cancelled - the caller is mid-sentence and semantic VAD
        // will start a reply on its own.
        if (this.toolFollowUp) {
          this.toolFollowUp = false;
          if (!cancelled) setTimeout(() => this.#raw({ type: 'response.create' }), 0);
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

  #handleToolCall(ev) {
    const name = ev.name || '(unnamed)';
    const callId = ev.call_id;
    let args = {};
    let parseError = null;
    try {
      args = ev.arguments ? JSON.parse(ev.arguments) : {};
    } catch (err) {
      parseError = err.message;
    }

    const result = parseError
      ? { ok: false, error: `could not read those arguments as JSON: ${parseError}` }
      : this.onToolCall(name, args);

    this.toolCallsThisResponse++;
    const verdict = result?.ok === false ? `REFUSED - ${result.error}` : 'ok';
    log.info('agent noted', `${name} ${JSON.stringify(args).slice(0, 160)} -> ${verdict}`);

    if (!callId) return log.warn('tool', `${name} arrived without a call_id, cannot answer it`);

    this.#raw({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result ?? { ok: true }),
      },
    });
    this.toolFollowUp = true;
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
    this.greetingPrompt = prompt;
    this.greetingPending = true;
    this.greetingAttempts = 0;
    this.whenReady(() => this.#createGreeting());
  }

  #createGreeting() {
    if (!this.greetingPending) return;
    this.audioFramesThisResponse = 0;
    this.awaitingGreetingId = true;
    this.#raw({ type: 'response.create', response: { instructions: this.greetingPrompt } });
    log.stage('AGENT_GREET', JSON.stringify(this.greetingPrompt).slice(0, 120));
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
