// Tracks the gap between audio we hand to Twilio and audio the caller has
// actually heard.
//
// Azure generates speech faster than real time; Twilio plays it out at real
// time. So when a transcript arrives, most of that sentence is still sitting
// in Twilio's buffer. If the caller interrupts we send a clear, Twilio drops
// the buffer, and the caller never hears it - but the transcript already said
// she said it. That is why the log and the phone call disagreed.
//
// Twilio's mark event is the honest signal: it comes back only once a chunk
// has finished playing to the caller. Everything in here is byte counting and
// timestamps. Nothing reads or interprets what anyone said.

const BYTES_PER_MS = 8; // mu-law, 8 kHz, mono -> 8000 bytes per second

// Exact decoded length without allocating a Buffer for every frame.
export function b64Bytes(b64) {
  if (!b64) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

export class Playback {
  constructor({ onSettled = () => {} } = {}) {
    this.onSettled = onSettled;
    this.queuedMs = 0; // audio handed to Twilio
    this.playedMs = 0; // audio Twilio confirmed finished playing
    this.seq = 0;
    this.marks = new Map();     // mark name -> cumulative ms at end of chunk
    this.responses = new Map(); // response id -> ledger row
    this.firstLagMs = null;
  }

  startResponse(id) {
    if (!id) return;
    this.responses.set(id, {
      id,
      startMs: this.queuedMs,
      lastMs: this.queuedMs,
      endMs: null,
      text: null,
      status: null,
      settled: false,
    });
  }

  // Call with the base64 chunk we just sent Twilio. Returns the mark name to
  // send after it, so Twilio can tell us when it finished playing.
  queue(b64, responseId) {
    const ms = b64Bytes(b64) / BYTES_PER_MS;
    this.queuedMs += ms;
    const name = `m${++this.seq}`;
    this.marks.set(name, { cumMs: this.queuedMs, sentAt: Date.now() });
    const row = this.responses.get(responseId);
    // Running high-water mark for this response. Only becomes the end once
    // the response is actually over - see endResponse.
    if (row) row.lastMs = this.queuedMs;
    return name;
  }

  // Twilio finished playing everything up to this mark.
  confirmMark(name) {
    const rec = this.marks.get(name);
    if (!rec) return null;
    this.marks.delete(name);
    if (rec.cumMs > this.playedMs) this.playedMs = rec.cumMs;
    const lag = Date.now() - rec.sentAt;
    if (this.firstLagMs === null) this.firstLagMs = lag;
    this.#settle();
    return lag;
  }

  // The caller interrupted, so Twilio is dropping whatever it had buffered.
  // Everything past playedMs is audio nobody ever heard.
  clear() {
    const droppedMs = Math.max(0, this.queuedMs - this.playedMs);
    this.queuedMs = this.playedMs;
    this.marks.clear();
    for (const row of this.responses.values()) {
      if (!row.settled && row.endMs === null) row.endMs = row.lastMs;
    }
    this.#settle({ flush: true });
    return droppedMs;
  }

  // Azure finished (or cancelled) a response, and we have its transcript.
  // A cancelled response is settled straight away: whatever has not played by
  // now never will, because the buffer behind it has already been dropped.
  endResponse(id, text, status) {
    const row = this.responses.get(id);
    if (!row) return;
    row.text = text ?? row.text;
    row.status = status ?? row.status;
    if (row.endMs === null) row.endMs = row.lastMs;
    this.#settle({ flush: status === 'cancelled' });
  }

  // How far behind the caller is right now, in ms of audio still queued.
  get backlogMs() {
    return Math.max(0, this.queuedMs - this.playedMs);
  }

  // A row is settled once its audio has finished playing, or once a clear
  // means the rest of it never will.
  #settle({ flush = false } = {}) {
    for (const row of this.responses.values()) {
      if (row.settled || row.endMs === null || row.text === null) continue;
      const finishedPlaying = this.playedMs >= row.endMs - 0.5;
      if (!finishedPlaying && !flush) continue;

      const totalMs = Math.max(0, row.endMs - row.startMs);
      const heardMs = Math.max(0, Math.min(totalMs, this.playedMs - row.startMs));
      row.settled = true;
      this.responses.delete(row.id);
      this.onSettled({
        id: row.id,
        text: row.text,
        status: row.status,
        totalMs,
        heardMs,
        heardFraction: totalMs > 0 ? heardMs / totalMs : 0,
      });
    }
  }
}
