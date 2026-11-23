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
];

const OUTAGE = [
  'What the fuck happened here?',
  'Who pulled the plug?',
  'Oh no. Oh no no no.',
  'This is fine. Everything is fine.',
  'Not on my shift.',
  'Jesus Christ on a bike.',
];

export type CurseKind = 'action' | 'outage';

/** A random line for one visit: `action` for a start/stop/restart, `outage` for an alert. */
export const pickCurse = (kind: CurseKind) => {
  const lines = kind === 'action' ? ACTION : OUTAGE;
  return lines[Math.floor(Math.random() * lines.length)];
};
