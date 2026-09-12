// Offline analysis of saved calls. Prints the raw neighbourhood around every
// place the agent spoke twice with no caller turn in between, so the cause is
// visible rather than inferred. Counts words and compares timestamps only.
import fs from 'node:fs';
import path from 'node:path';

const dir = 'calls';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.transcript.json')).sort();

const show = (l) => {
  const who = l.who === 'them' ? 'THEM ' : l.who === 'agent' ? 'AGENT' : l.who === 'tool' ? 'NOTE ' : '--   ';
  const text = l.who === 'tool' ? l.tool : l.blank ? '(nothing we could make out)' : l.text;
  return `[${String(l.at).padStart(6)}s] ${who} ${String(text).slice(0, 74)}`;
};

let doubles = 0;
let withToolBetween = 0;
let withBlankBetween = 0;
let withNothingBetween = 0;

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const lines = j.lines || [];
  if (lines.length < 4) continue;

  const spots = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].who !== 'agent') continue;

    // Walk back over anything that is not a real caller turn.
    let k = i - 1;
    let sawTool = false;
    let sawBlank = false;
    while (k >= 0 && (lines[k].who === 'tool' || lines[k].who === 'system' || (lines[k].who === 'them' && lines[k].blank))) {
      if (lines[k].who === 'tool') sawTool = true;
      if (lines[k].who === 'them') sawBlank = true;
      k--;
    }
    if (k < 0 || lines[k].who !== 'agent') continue;

    doubles++;
    // A tool note is written the moment the tool runs, but an agent line is
    // written when the whole response settles - so a tool belonging to the
    // first reply sits before it, not between the two. Look back past it.
    let toolBefore = null;
    for (let n = k; n >= 0 && lines[k].at - lines[n].at <= 12; n--) {
      if (lines[n].who === 'tool') { toolBefore = lines[n]; break; }
      if (lines[n].who === 'them' && !lines[n].blank) break;
    }
    if (sawTool || toolBefore) withToolBetween++;
    else if (sawBlank) withBlankBetween++;
    else withNothingBetween++;
    spots.push({ i, from: k, gap: Math.round((lines[i].at - lines[k].at) * 10) / 10, sawTool, sawBlank, toolBefore });
  }

  if (!spots.length) continue;
  console.log(`\n=== ${f.slice(0, 24)}  ${j.durationSeconds}s ===`);
  for (const s of spots) {
    const why = s.sawTool || s.toolBefore
      ? `a tool ran first (${(s.sawTool ? 'between' : s.toolBefore.tool)})`
      : s.sawBlank ? 'an empty caller turn between them' : 'NO tool anywhere near it';
    console.log(`\n  second reply +${s.gap}s later - ${why}`);
    for (let n = Math.max(0, s.from - 2); n <= Math.min(lines.length - 1, s.i + 1); n++) {
      console.log(`    ${n === s.i ? '>>' : '  '} ${show(lines[n])}`);
    }
  }
}

console.log(`\n${doubles} double replies: ${withToolBetween} had a tool run just before, ${withBlankBetween} after an empty caller turn, ${withNothingBetween} with no tool anywhere near`);
