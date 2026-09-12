# Ring Around — what went wrong, and what we did about it

A build log for a single day: 12 September 2026, 10:19 to 14:30.
Twelve commits, six test files, 196 checks, and roughly a dozen live phone calls.

---

## Summary

**Ring Around is an AI voice agent that phones appliance-repair shops on your
behalf and comes back with real quotes, call-out fees and two booked time
slots.** You press one button; it finds the shops, calls them one at a time,
and fills in a comparison table while you watch the transcript scroll past.

It works. It has held a four-minute conversation with a repair shop, read a
$89 call-out fee back to be corrected, refused a Sunday because the customer
isn't free on Sundays, and booked two slots — all without a human on the line.

The interesting part of the day was not getting it to talk. That took about
two hours. The interesting part was everything that went wrong afterwards, and
almost none of it was what we expected.

**Three things are worth saying out loud in a demo:**

**1. Most of the failures were not AI failures.** The agent said
"an application error has occurred" and hung up — that was a dead tunnel, not
the model. Contractors in Redmond came back with Iowa phone numbers — that was
a missing parameter, not a hallucination. Calls stopped reaching the phone —
that was carrier screening. We spent far more of the day on plumbing than on
prompting, and the single highest-value thing we built was a log line at every
stage boundary so a broken call names its own broken hop instead of making us
guess.

**2. The rule that shaped the whole codebase: the model reads language, the
code only counts.** There is no regex anywhere that tries to work out what a
person meant. Not for "yes we cover that area", not for "fifty" versus
"fifteen", not for a time slot. The model interprets; the code checks ranges,
compares timestamps, counts turns, and refuses things. This kept us out of a
whole category of bug, and it is why the agent can handle "uh, sure, um, I can
come out today from 5 to 8, is that okay?" without anyone writing a parser.

**3. The corollary: never let the model be the only path to a decision that
matters.** Every safety-critical judgement is paired with a deterministic
backstop. The agent can *decide* to hang up because the shop is out of area —
but code checks it actually heard them say words first, and refuses if the
line was silent. The agent can *decide* a time slot works — but code checks it
against the availability window and refuses if it doesn't. It also literally
cannot dial a number that didn't come from a structured API field.

The one genuine AI-behaviour bug we found, we found by reading transcripts
rather than logs — and the fix was two lines. Details in §7.

---

## 1. Getting audio onto the phone at all

### Problem: two different audio worlds
Twilio Media Streams speak 8 kHz mu-law. Azure OpenAI Realtime, by default,
speaks 24 kHz PCM. Resampling in the middle would have meant a transcode on
every 20 ms frame in both directions, with latency and drift to match.

**Facts**
- Twilio sends base64 mu-law frames over a websocket, about 50 per second.
- Azure Realtime accepts a configurable input and output format.
- Azure supports `audio/pcmu` — the same 8 kHz mu-law Twilio uses.

**Solved.** We set both ends to `audio/pcmu` and forward the base64 payload
untouched. **Zero transcoding in either direction.** No resampler, no buffer
alignment, no drift. This is worth a slide on its own: the right format choice
deleted an entire subsystem.

### Problem: the Azure endpoint 404'd
The documented preview URL returned HTTP 404 against a GA api-version.

**Facts**
- `wss://<host>/openai/realtime?deployment=<name>` — preview only.
- `wss://<host>/openai/v1/realtime?model=<deployment>` — the GA path.
- `?deployment=` on the GA path returns HTTP 400 with
  *"This operation requires either model=<deployment-id> or intent=transcription"*.

**Solved.** Use the GA path with `model=<deployment-name>`. Verified by
connecting to each variant and recording the response code rather than trusting
documentation.

---

## 2. "An application error has occurred, goodbye"

This is Twilio's canned message, and it sounds exactly like the agent crashed.
It isn't. It means Twilio could not fetch instructions from us.

**Facts**
- We reach Twilio through a free `cloudflared` tunnel.
- Free tunnels get a new hostname on every restart and die without warning.
  **Three died during one working day.**
- The log signature is unmistakable once you know it: `CALL_CREATE` is logged,
  then **no `TWILIO_FETCH_TWIML` and no status callbacks at all**. Twilio never
  reached us, so nothing downstream ever ran.
- Each restart needs a new `PUBLIC_HOST` *and* a server restart.

**Solved.** `assertReachable()` in `dialer.js` POSTs to our own public `/twiml`
from outside the machine and requires a real `<Stream>` element back — *before*
any number is dialled. A dead tunnel now fails in about 300 ms with a message
on screen, instead of burning a phone call and 45 seconds of ringing.

**Lesson for the demo:** the error message a system shows you is written by
whoever is closest to the user, not by whoever caused the problem. Twilio blamed
"an application error". The application was fine. The road was out.

---

## 3. The phone stopped ringing

Four rapid failed calls during the dead-tunnel window, and then calls stopped
arriving at the handset entirely.

**Facts**
- A call that reached the phone showed:
  `initiated → ringing (14s) → in-progress`.
- The calls that didn't showed:
  `initiated → in-progress`, answered in 12 s, **no `ringing` event at all**.
- Corroborating detail: 438 inbound audio frames, ~9 s duration, and a
  completely empty transcript. Something picked up and said nothing.
- **`ringing` is the tell.** Twilio only emits it when a handset physically
  rings. No `ringing` means voicemail or carrier screening answered.

**Solved, partly.** We enabled Twilio Answering Machine Detection
(`machineDetection: 'DetectMessageEnd'`, async so it doesn't delay the call) with
an `/amd` route that hangs up and marks the call as voicemail when a machine
answers. We also track a `rang` set so the log warns
*"answered without ever ringing"*.

**Still open.** Whether the number was durably flagged by the carrier, or the
screening cleared on its own. Four four-second calls in a row from an
unregistered number looks exactly like a robocaller — because, structurally, it
is one.

---

## 4. Contractors in Iowa

The portal found ten appliance-repair shops. Every phone number started 515.
That's Des Moines. The customer is in Redmond, Washington.

**Facts**
- `searchPlaces({ area = '' })` defaulted the area to an empty string.
- The portal never passed one, so the query sent to Google Places was literally
  `"appliance repair"` with **no location at all**.
- The API doesn't error on that. It silently returns nationwide results.
- Putting the city in the query text is only a weak hint; it does not constrain
  anything.

**Solved.** Three changes: `area` now defaults to the job's area and zip and
**throws** if empty rather than searching the whole country; a hard
`locationBias` circle (47.6740, −122.1215, 30 km); and `regionCode: 'US'`.
All results now come back 425 and 206 — Redmond and Bellevue.

**Lesson:** an empty string is a valid input to almost every API, and almost
never the input you meant. The fix was less about geography than about refusing
to run a query that doesn't make sense.

---

## 5. The assistant invented a fact about the customer's kitchen

While writing the portal spec, a throwaway phrase — "~4yrs" — was taken from a
chat message and written into the config as the cooktop's age. The agent would
then have told contractors, with total confidence, that the appliance was four
years old. Nobody knew that. It wasn't true.

**Facts**
- The value ended up in `.env` as `JOB_AGE`, and rendered on the job card as if
  it were established fact.
- The customer's actual answer, when asked, was "more than 10 years old".
- Two other details were wrong in the same way: the error code was recorded as
  a separate field rather than part of the problem description, and the cooktop
  was described as possibly radiant with "circular elements" when it is
  induction.

**Solved.** All three corrected at the source. The briefing now carries an
explicit rule: if something isn't known, **say it isn't known — never guess**.
The unknowns are listed by name so the agent can say "I don't have that on
hand" rather than filling the gap.

**Lesson, and a good one for a demo:** the hallucination risk in an agent system
isn't only the model at run time. It's every hop where a guess gets written down
as a fact and then read back later with a straight face. A number in a config
file looks authoritative no matter where it came from.

---

## 6. The portal showed nothing

The control panel loaded, showed the job card, and then sat there — through a
whole live call, and after it ended.

**Facts**
- The server was fine. `/api/status` had the row the entire time: *my phone,
  done, 64 s*, with findings attached and a transcript saved to disk.
- The page's entire state came from **one** Server-Sent Events connection.
- We restarted the server about six times while debugging. Each restart killed
  that stream, and the browser never reopened it.
- The server sent **no cache header**, so the browser kept serving stale HTML
  no matter how many times we fixed the page.
- The stream was opened *before* the buttons were wired, so a single throw
  there left every button dead.
- Transcripts existed only in the stream. Miss it — closed tab, reload, restart
  — and the words were gone from the page while sitting in `calls/` on disk.

**Solved.** Five changes, each one removing a single point of failure:
`cache-control: no-store`; state polled every 1.5 s independently of the
stream; the stream reconnects itself and shows a **live / reconnecting…**
indicator; a new `/api/transcript` route reads finished calls back off disk
(with a path-traversal guard); and buttons are wired *before* anything that can
throw. Any page error now appears in a red banner instead of a console nobody
is looking at.

**Lesson:** a panel that has silently stopped updating is worse than no panel.
It doesn't just fail — it actively lies, and you debug the wrong system. We
spent real time chasing a phone bug that was a stale web page.

---

## 7. The agent talked over itself

The one genuine AI-behaviour bug of the day — and the only one found by reading
transcripts rather than logs. The contractor eventually said it out loud:

> *"Okay, so you repeated yourself like three times."*
> *"Wait, wait, please stop cutting me off."*

**Facts, from an offline pass over every saved call**
- 7 double replies: the agent speaking twice with no caller turn in between.
- 13 replies to an utterance of three words or fewer.
- The agent's own lines record how much of each actually played. Four were
  heard at **59%, 19%, 10% and 2%** — the overlap is measurable, not a feeling.

**Two separate causes, which is why it was confusing.**

**Cause 1 — our code asked for a second reply (3 of 7).** When the agent writes
something on its notepad, the code queued an extra response for after the
current one finished. That was meant for refusals — "sorry, that slot doesn't
work". But if it had *already spoken* in that same turn, it had answered, and we
asked it to answer again:

```
[  192s] NOTE  note_time_slot
[192.6s] AGENT Do you need anything else from Yihan Sun…
[  193s] AGENT Thanks for that correction. Let's confirm the updated time…   ← heard 2%
```

0.4 seconds apart. **This proves it is not latency** — a late reply would be
stale content arriving slowly. This is fresh content generated twice.

**Cause 2 — "mm-hmm" counted as a full turn (4 of 7).** A backchannel committed
the audio buffer, so the model was handed the floor. With nothing to answer, it
re-asked its last question. Then did it again.

**Dated precisely with `git log -S`:**
- Cause 1 entered at **12:20**, in the commit that gave the agent a notepad.
  It could not have existed before — there were no tools to follow up on.
- Cause 2 has been there since **10:19**, the first working relay. It never got
  worse; it got *more visible*, once the agent had six objectives to work
  through instead of just chatting.

**Solved.**
- The follow-up reply now fires only when there is a reason to speak: the note
  was refused, the price is over budget, or the note was written in silence
  (where staying quiet would be dead air). Call-ending tools are tagged so
  hanging up no longer triggers one more thing to say.
- Turn detection eagerness `auto` → `low`, so a backchannel stops stealing the
  agent's place in its own sentence.
- `input_audio_transcription.failed` is now handled. It was triggering a model
  turn while writing **nothing** to the transcript — which is exactly why 4 of
  the 7 doubles appeared to come from nowhere.
- Five new tests pin the behaviour so it cannot quietly return.

**A bonus catch.** Azure accepts a session and silently ignores settings inside
it. A dropped `eagerness` would change behaviour on every call with nothing to
indicate why. Preflight now *asserts* that what came back matches what we sent.

---

## 8. Smaller things that cost real time

### A call died mid-sentence at 301 seconds
`MAX_CALL_SECONDS` was 300. The agent was two exchanges from booking. Raised to
600. Worth noting because the call looked like a crash and wasn't.

### Ranking put the wrong shop first
A 5.0 rating with **one** review outranked a 4.8 with **1,135**. One review is
not evidence. Now scored as `stars × (1 + log₁₀(reviews) / 10)` — every tenfold
jump in reviews is worth another 10%, so stars stay in charge but a track record
counts. A 4.8 with 1,000 reviews scores 6.24; a 5.0 with one scores 5.00.

### Silence read as an answer
The agent once treated a quiet line as confirmation. Ending a call because
someone is "out of area" now requires having actually heard words — a blank
transcript is not a refusal, it's just silence on a phone line. This is a code
check on turn counts, not on content.

### The disclosure got cut off
The greeting carries the "I'm an AI assistant" disclosure, and line noise at
pickup can trip voice detection before a word is out. It is now retried — but
only when the response was cancelled having produced **zero** audio frames, tied
to that exact response id, so a caller interrupting later can never be mistaken
for it.

### What was generated is not what was heard
Azure produces audio faster than real time, and a barge-in throws away whatever
is still in Twilio's buffer. A transcript that records what the model *said*
rather than what the caller *heard* is a transcript that lies. Every agent line
now carries a "heard %".

### Whisper wanders
On noisy phone audio, transcription left to guess the language will pick the
wrong one — and the agent follows it there and keeps talking in it. Pinned to
English.

---

## What we'd tell someone starting this tomorrow

1. **Log every stage boundary before anything breaks, not after.** Twenty-six
   named stages. Nearly every bug above was diagnosed by noticing which stage
   was missing. The absence of `TWILIO_FETCH_TWIML` was worth more than any
   stack trace we saw all day.
2. **Check reachability before you spend a phone call.** Anything crossing a
   network boundary should be proven from the outside first.
3. **Let the model read language; make the code count things.** No regex on
   speech. It is not a purity argument — it's that "yes we cover that area" has
   a thousand forms and two of them are sarcastic.
4. **Then never trust the model alone on anything that matters.** Every
   important decision it makes has a deterministic check behind it.
5. **Never let a UI depend on a single stream.** Poll as well. A silent panel
   sends you debugging the wrong system.
6. **Read the transcripts.** The logs were clean on the day the agent was
   talking over people. The contractor told us, in words, on the recording.
