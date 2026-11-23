/**
 * The technician's vocabulary. One line is picked per visit and stays put while he works,
 * so the bubble does not flicker.
 */
const ACTION = [
  "Oh, for fuck's sake.",
  'Not this shit again.',
  'Who the hell restarted this?',
  'I just fixed that.',
  'Bloody hell.',
  'Great. Just great.',
  'Do I look like I have time for this?',
  'Who keeps touching production?',
  'Again? Seriously?',
  'That is above my pay grade.',
  "I'm going to need a bigger coffee.",
  'Somebody is getting a strongly worded ticket.',
  'Absolutely fucking marvelous.',
  'Right. Who broke it this time?',
  'I swear to God, if this is another deploy…',
  'Cool. Cool cool cool.',
  'Fantastic. Another restart.',
  'Why is it always this one?',
  'I was literally on my break.',
  'This had better not be a cache.',
];

const OUTAGE = [
  'What the fuck happened here?',
  'Who pulled the plug?',
  'Oh no. Oh no no no.',
  'This is fine. Everything is fine.',
  'Not on my shift.',
  'Jesus Christ on a bike.',
  "Well, that's fucked.",
  'Who deployed on a Friday?',
  "Of course it's down. Of course.",
  'I leave for five minutes…',
  "This wasn't in the runbook.",
  'Somebody call an adult.',
  'The logs better be good.',
  "I'm not paid enough for this.",
  "Right, who's the genius?",
  'Everything is on fire. As usual.',
  'Hold my coffee.',
];

export type CurseKind = 'action' | 'outage';

/** A random line for one visit: `action` for a start/stop/restart, `outage` for an alert. */
export const pickCurse = (kind: CurseKind) => {
  const lines = kind === 'action' ? ACTION : OUTAGE;
  return lines[Math.floor(Math.random() * lines.length)];
};
