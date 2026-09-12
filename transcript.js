// A written record of what was actually said on a call.
//
// Two things are recorded for the agent's turns, and they are not the same
// thing: what the model produced, and how much of it the caller really heard.
// Azure generates faster than real time and a barge-in throws away whatever
// is still sitting in Twilio's buffer, so a line can be "said" and never
// arrive. A transcript that hides that is a transcript that lies.

import fs from 'node:fs';
import path from 'node:path';
import * as log from './log.js';

export class Transcript {
  constructor({ callSid = null, to = null, company = null, onLine = null } = {}) {
    // Someone watching the portal wants the line now, not when the call ends.
    this.onLine = onLine;
    this.callSid = callSid;
    this.to = to;
    this.company = company;
    this.startedAt = Date.now();
    this.lines = [];
  }

  push(line) {
    this.lines.push(line);
    if (this.onLine) {
      try {
        this.onLine(line);
      } catch {}
    }
    return line;
  }

  #at() {
    return Math.round((Date.now() - this.startedAt) / 100) / 10;
  }

  caller(text) {
    const said = String(text ?? '').trim();
    // An empty transcript is not nothing worth knowing - it is the signal that
    // the line went quiet, which is exactly what tricked the agent once.
    this.push({ at: this.#at(), who: 'them', text: said, blank: said.length === 0 });
  }

  // Called when a response settles, once we know how much of it played.
  agent(text, { heardFraction = 1, heardMs = null, totalMs = null, status = 'completed' } = {}) {
    const said = String(text ?? '').trim();
    if (!said) return;
    this.push({
      at: this.#at(),
      who: 'agent',
      text: said,
      heardPct: Math.round(heardFraction * 100),
      heardMs,
      totalMs,
      status,
    });
  }

  tool(name, args, result) {
    this.push({
      at: this.#at(),
      who: 'tool',
      tool: name,
      args,
      ok: result?.ok !== false,
      error: result?.ok === false ? result.error : undefined,
    });
  }

  event(text) {
    this.push({ at: this.#at(), who: 'system', text });
  }

  // Plain text, for reading. The percentages are the honest part.
  toText() {
    const head = [
      `Call ${this.callSid || '(no sid)'}`,
      this.company ? `To: ${this.company} ${this.to || ''}`.trim() : this.to ? `To: ${this.to}` : null,
      `Started: ${new Date(this.startedAt).toISOString()}`,
      '',
    ].filter(Boolean);

    const body = this.lines.map((l) => {
      const t = `[${String(l.at).padStart(6)}s]`;
      if (l.who === 'them') return `${t} THEM   ${l.blank ? '(nothing we could make out)' : l.text}`;
      if (l.who === 'tool') return `${t} NOTE   ${l.tool} ${JSON.stringify(l.args)}${l.ok ? '' : `  REFUSED: ${l.error}`}`;
      if (l.who === 'system') return `${t} --     ${l.text}`;
      const heard =
        l.heardPct >= 99 ? '' : l.heardPct < 5 ? '   <- they never heard this' : `   <- they only heard ${l.heardPct}% of this`;
      return `${t} AGENT  ${l.text}${heard}`;
    });

    return [...head, ...body, ''].join('\n');
  }

  toJSON() {
    return {
      callSid: this.callSid,
      to: this.to,
      company: this.company,
      startedAt: new Date(this.startedAt).toISOString(),
      durationSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      lines: this.lines,
    };
  }

  // Written next to the notes, same stem, so a call is one pair of files.
  save(dir = 'calls', stem = null) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const name = stem || `${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}-${this.callSid || 'nosid'}`;
      fs.writeFileSync(path.join(dir, `${name}.txt`), this.toText());
      fs.writeFileSync(path.join(dir, `${name}.transcript.json`), JSON.stringify(this.toJSON(), null, 2));
      log.info('saved', `${dir}/${name}.txt`);
      return name;
    } catch (err) {
      log.warn('saved', `could not write the transcript: ${err.message}`);
      return null;
    }
  }
}
