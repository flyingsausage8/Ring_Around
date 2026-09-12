// The notepad the agent writes on during a call.
//
// The model listens, decides what a person meant, and calls one of these with
// the values. Code stores them and checks their shape. Nothing here reads the
// conversation - if a tool is never called, nothing is recorded, which is the
// honest outcome.
//
// Every tool takes theirWords: a short quote of what was said. That is there
// to make the model ground itself before writing a number down, not as
// evidence for code to check. Nothing compares it to the transcript.

import { cleanDigits, dtmfDurationMs } from './dtmf.js';

const theirWords = {
  type: 'string',
  description: 'Roughly what they said, in their words. Keep it short.',
};

export const TOOLS = [
  {
    type: 'function',
    name: 'note_service_area',
    description:
      'Record whether this company covers the job zip code. Call this as soon as you know, and if they do not cover it, wrap the call up politely.',
    parameters: {
      type: 'object',
      properties: {
        covers: { type: 'boolean', description: 'true if they service the area' },
        theirWords,
      },
      required: ['covers'],
    },
  },
  {
    type: 'function',
    name: 'note_quote',
    description:
      'Record a rough price for the repair itself. Use it for a range, a single figure, or a starting price. Do not call it for the call-out fee - that has its own tool. Say the figure back out loud and let them confirm it before you call this. Phone audio mangles numbers.',
    parameters: {
      type: 'object',
      properties: {
        lowUsd: { type: 'number', description: 'Low end in US dollars, or the only figure given.' },
        highUsd: { type: 'number', description: 'High end in US dollars. Leave out if they gave one number.' },
        basis: {
          type: 'string',
          description: 'What the figure depends on, if they said - parts, labour, the model, and so on.',
        },
        theirWords,
      },
      required: ['lowUsd'],
    },
  },
  {
    type: 'function',
    name: 'note_job_duration',
    description: 'Record how long the actual repair takes once they are on site, in minutes.',
    parameters: {
      type: 'object',
      properties: {
        minMinutes: { type: 'number', description: 'Shortest, in minutes. 90 for "an hour and a half".' },
        maxMinutes: { type: 'number', description: 'Longest, in minutes. Leave out if they gave one figure.' },
        theirWords,
      },
      required: ['minMinutes'],
    },
  },
  {
    type: 'function',
    name: 'note_callout',
    description:
      'Record the call-out or diagnostic fee for coming out, and whether it comes off the bill if the repair goes ahead. Use 0 if there is no fee. Say the figure back out loud and let them confirm it before you call this. Phone audio mangles numbers.',
    parameters: {
      type: 'object',
      properties: {
        feeUsd: { type: 'number', description: 'The fee in US dollars. 0 if they do not charge one.' },
        waivedIfRepaired: {
          type: 'boolean',
          description: 'true if it is waived or credited when the repair goes ahead. Leave out if they did not say.',
        },
        theirWords,
      },
      required: ['feeUsd'],
    },
  },
  {
    type: 'function',
    name: 'note_visit_duration',
    description: 'Record how long the estimate or diagnostic visit itself takes, in minutes.',
    parameters: {
      type: 'object',
      properties: {
        minMinutes: { type: 'number', description: 'Shortest, in minutes.' },
        maxMinutes: { type: 'number', description: 'Longest, in minutes. Leave out if they gave one figure.' },
        theirWords,
      },
      required: ['minMinutes'],
    },
  },
  {
    type: 'function',
    name: 'note_lead_time',
    description:
      'Record how soon they could get out to this job - same day, later this week, a fortnight, whatever they said.',
    parameters: {
      type: 'object',
      properties: {
        soonest: { type: 'string', description: 'Short phrase, like "Thursday this week" or "about two weeks".' },
        theirWords,
      },
      required: ['soonest'],
    },
  },
  {
    type: 'function',
    name: 'note_time_slot',
    description:
      'Record a visit time that works for both sides. Call it once per slot, and you need two. Before you call this, say the day, the date and the hour back out loud and let them confirm it - "Thursday the eighteenth, one to three" - because phone audio mangles numbers and a wrong appointment is worse than no appointment. It will be refused if the time falls outside what the client is free for - if that happens, say so on the call and ask for another time.',
    parameters: {
      type: 'object',
      properties: {
        day: {
          type: 'string',
          enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
          description: 'Day of the week.',
        },
        date: {
          type: 'string',
          description: 'The actual date as YYYY-MM-DD. Work it out from today\'s date, given to you below.',
        },
        startTime: { type: 'string', description: '24 hour HH:MM. 1pm is 13:00.' },
        endTime: { type: 'string', description: '24 hour HH:MM. 3pm is 15:00.' },
        theirWords,
      },
      required: ['day', 'startTime', 'endTime'],
    },
  },
  {
    type: 'function',
    name: 'note_declined',
    description:
      'Record that they will not answer something - a price over the phone, say. Call this instead of asking again. It is a normal outcome, not a failure.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'What they would not give, in a couple of words. "repair price", "call-out fee".',
        },
        theirWords,
      },
      required: ['topic'],
    },
  },
  {
    type: 'function',
    name: 'note_outcome',
    description: 'Record how the call ended. Call this once, right before you say goodbye.',
    parameters: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['booked', 'quote_only', 'call_back_later', 'declined', 'out_of_area', 'wrong_trade', 'no_answer'],
          description: 'The closest match.',
        },
        summary: { type: 'string', description: 'One sentence on what happened.' },
      },
      required: ['outcome'],
    },
  },
  {
    type: 'function',
    name: 'press_keys',
    description:
      'Press buttons on the phone keypad, exactly as a person would. Use this for an automated menu: "press 0 for a representative", "enter your zip code", "press 1 for service". The tones play down the line and then you should stay quiet and listen to what the menu does next. You may call this as many times as a menu needs.',
    parameters: {
      type: 'object',
      properties: {
        digits: {
          type: 'string',
          description: 'The keys to press, in order. Digits 0-9, * and # only. For example "0" or "98052".',
        },
        why: {
          type: 'string',
          description: 'What the menu asked for, in your own words, so the log says why these keys.',
        },
      },
      required: ['digits'],
    },
  },
  {
    type: 'function',
    name: 'wait_on_hold',
    description:
      'Stay on the line without talking. Use this when you have been put in a queue or told you are being transferred - "please hold", "the next available agent will be with you". Say nothing while you wait; hold music is not a person and does not need answering. Call it again if you are still waiting when it runs out.',
    parameters: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: 'How long to keep waiting before you check in again. 30 to 120 is normal.',
        },
        why: { type: 'string', description: 'What you were told, in your own words.' },
      },
      required: ['seconds'],
    },
  },
  {
    type: 'function',
    name: 'note_bad_pickup',
    description:
      'Call this only when there is no way through to a person on this call: an answering machine or voicemail greeting, or a line that answered with nobody on it. Do not leave a message. A menu is NOT a bad pickup - press the keys instead. Being put on hold or in a queue is NOT a bad pickup - wait. Call this and the call ends.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['voicemail', 'no_one_there', 'wrong_number', 'menu_dead_end'],
          description: 'What picked up. Use menu_dead_end only after you have actually tried the keypad and it led nowhere.',
        },
        theirWords: {
          type: 'string',
          description: 'Roughly what the recording or the menu said.',
        },
      },
      required: ['kind'],
    },
  },
  {
    type: 'function',
    name: 'end_call',
    description:
      'Hang up. Say your goodbye first, then call this - your goodbye is played in full before the line actually drops. Call it right away, without a goodbye, only if they ask you to go, if they are hostile, or if nobody is there.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['said_goodbye', 'they_asked', 'bad_time', 'out_of_area', 'wrong_trade', 'hostile', 'no_one_there'],
          description: 'Why the call is ending.',
        },
      },
      required: ['reason'],
    },
  },
];

// Tool name -> the method on Findings that handles it.
const HANDLERS = {
  note_service_area: 'noteServiceArea',
  note_quote: 'noteQuote',
  note_job_duration: 'noteJobDuration',
  note_callout: 'noteCallout',
  note_visit_duration: 'noteVisitDuration',
  note_lead_time: 'noteLeadTime',
  note_time_slot: 'noteTimeSlot',
  note_declined: 'noteDeclined',
  note_outcome: 'noteOutcome',
};

export function runTool(findings, name, args, hooks = {}) {
  if (name === 'press_keys') {
    const asked = String((args && args.digits) || '');
    const { digits, dropped } = cleanDigits(asked);
    if (!digits) {
      return { ok: false, error: `"${asked}" has nothing a phone can press - only 0-9, * and # exist on a keypad.` };
    }
    // A menu that is sent thirty keys is a menu being hammered, not answered.
    if (digits.length > 20) {
      return { ok: false, error: 'that is too many keys for one press - send them a few at a time.' };
    }
    if (typeof hooks.onPressKeys !== 'function') {
      return { ok: false, error: 'this line cannot press keys' };
    }
    const ms = dtmfDurationMs(digits);
    hooks.onPressKeys(digits, args?.why);
    findings.notePressedKeys?.(digits, args?.why);
    return {
      ok: true,
      pressed: digits,
      // Say so rather than pretending the whole string went through. Dialling
      // four fifths of a zip code puts you somewhere real and wrong.
      note: dropped.length
        ? `pressed ${digits} - ${dropped.join(', ')} could not be pressed. Listen for what the menu does, then say nothing until it has finished.`
        : `pressed ${digits}. Now stay quiet and listen - the menu needs about ${Math.ceil(ms / 1000) + 2} seconds to respond.`,
    };
  }
  if (name === 'wait_on_hold') {
    // A queue is worth real patience - it is the company trying to reach us -
    // but not unlimited patience, or one dead line eats the whole run.
    const asked = Number(args?.seconds);
    const seconds = Number.isFinite(asked) ? Math.max(10, Math.min(120, asked)) : 60;
    if (typeof hooks.onHold !== 'function') return { ok: false, error: 'this line cannot be held' };
    hooks.onHold(seconds, args?.why);
    return {
      ok: true,
      waitingSeconds: seconds,
      note: `holding for ${seconds}s. Say nothing at all until a person speaks to you - if you talk to hold music you will be talking over whoever picks up.`,
    };
  }
  if (name === 'note_bad_pickup') {
    const kind = String((args && args.kind) || 'no_one_there');
    findings.noteBadPickup(kind, args?.theirWords);
    if (typeof hooks.onEndCall === 'function') hooks.onEndCall('no_one_there');
    return { ok: true, ending: true, note: 'noted - stop talking, the call is ending' };
  }
  if (name === 'end_call') {
    const reason = String((args && args.reason) || 'said_goodbye');
    // Ending the call because of something they supposedly said needs them to
    // have actually said it. A blank transcript is not a refusal, an
    // out-of-area or a wrong trade - it is just silence on a phone line.
    const restsOnTheirWords =
      reason === 'out_of_area' || reason === 'wrong_trade' || reason === 'they_asked' || reason === 'bad_time';
    if (restsOnTheirWords && !findings.heardSomething()) {
      return {
        ok: false,
        error: `you have not heard them say anything that supports "${reason}" - the line went quiet. Check in with them and wait for a real answer before ending the call.`,
      };
    }
    findings.noteHangup(reason);
    if (typeof hooks.onEndCall === 'function') hooks.onEndCall(reason);
    // The line does not drop here. server.js waits for the goodbye to finish
    // playing out of Twilio's buffer first.
    return { ok: true, ending: true, note: 'wrapping up - finish your goodbye, do not start anything new' };
  }
  const method = HANDLERS[name];
  if (!method) return { ok: false, error: `no such tool: ${name}` };
  try {
    return findings[method](args || {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
