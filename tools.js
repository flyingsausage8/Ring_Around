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
    return { ok: true, note: 'wrapping up - finish your goodbye, do not start anything new' };
  }
  const method = HANDLERS[name];
  if (!method) return { ok: false, error: `no such tool: ${name}` };
  try {
    return findings[method](args || {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
