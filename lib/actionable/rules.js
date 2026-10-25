// lib/actionable/rules.js
// ---------------------------------------------------------------------------
// The local rules organizer — a provider for the Actionable extraction chain
// that runs NO model, makes NO network call, and costs nothing per capture.
//
// It plugs into the exact slot the vendors occupy (providers.js): call()
// takes the same arguments and returns { text } where text is a JSON object
// string in the wire shape EXTRACTION_JSON_SCHEMA declares, so
// normalizeEntry() in extract.js validates it exactly like a model answer.
//
// DESIGN LAWS (from prompt.js — they bind rules harder than they bind a
// model, because rules cannot bluff):
//   * Never invent a due date. Unparseable time language → due empty, and
//     NO phone action. A wrong 6 AM alarm is the worst failure mode.
//   * No time, no phone action — even when a reminder was requested, unless
//     a time is known or clearly implied ("when I wake up" ≈ 7 AM).
//   * Coverage is accounting, not vibes: every sentence of the dump must
//     land in an item, in `unclear`, or in the filler table. A clause with
//     no content verb, no number, no question form and no known name is NOT
//     turned into an invented item — it goes to `unclear` verbatim.
//   * Repairs are shown: known-name and known-phrase garble fixes are
//     recorded in transcription_repairs, never applied silently.
//
// All word knowledge lives in rules-tables.js (data only) so the flywheel
// can extend it without touching this logic.
// ---------------------------------------------------------------------------

import { SEED_PROJECTS } from './prompt.js';
import * as T from './rules-tables.js';

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const lower = (s) => String(s || '').toLowerCase();

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-phrase containment on word boundaries, case-insensitive.
function hasPhrase(text, phrase) {
  return new RegExp(`\\b${escapeRe(phrase)}\\b`, 'i').test(text);
}

function tokenize(text) {
  return lower(text).split(/[^a-z0-9%$]+/).filter(Boolean);
}

// Crude singular: customers→customer, tags→tag. Used only for keyword
// scoring, where a near miss costs nothing.
function stem(word) {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

// ---------------------------------------------------------------------------
// Verb forms — CONTENT_VERBS holds base forms; expand regular inflections
// plus the irregular map so "hauled" and "took" both register as verbs.
// ---------------------------------------------------------------------------

const VERB_FORMS = (() => {
  const forms = new Map(); // form -> base
  for (const base of T.CONTENT_VERBS) {
    forms.set(base, base);
    forms.set(base + 's', base);
    forms.set(base + 'es', base);
    forms.set(base + 'ed', base);
    forms.set(base + 'd', base);
    forms.set(base + 'ing', base);
    if (base.endsWith('e')) forms.set(base.slice(0, -1) + 'ing', base);
    // doubled final consonant: stop→stopped, tag→tagged, drop→dropped
    if (/[^aeiou][aeiou][^aeiouwxy]$/.test(base)) {
      const dbl = base + base.slice(-1);
      forms.set(dbl + 'ed', base);
      forms.set(dbl + 'ing', base);
    }
  }
  for (const [form, base] of Object.entries(T.IRREGULAR_VERB_FORMS)) {
    forms.set(form, base);
  }
  return forms;
})();

export function contentVerbOf(token) {
  return VERB_FORMS.get(lower(token)) || null;
}

function contentVerbsIn(text) {
  return tokenize(text).map(contentVerbOf).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Timezone wall-clock math (no dependencies). Dates are resolved as WALL
// times in the caller's zone, then rendered as ISO with that zone's offset.
// ---------------------------------------------------------------------------

function zonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

function offsetMinutesAt(utcMs, tz) {
  const p = zonedParts(new Date(utcMs), tz);
  return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - utcMs) / 60000;
}

function wallToIso({ y, mo, d, h, mi }, tz) {
  let utc = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 3; i++) utc = Date.UTC(y, mo - 1, d, h, mi, 0) - offsetMinutesAt(utc, tz) * 60000;
  const off = offsetMinutesAt(utc, tz);
  const sign = off < 0 ? '-' : '+';
  const ao = Math.abs(off);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:00${sign}${p2(Math.floor(ao / 60))}:${p2(ao % 60)}`;
}

function addDays(wall, n) {
  const t = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(wall) {
  return new Date(Date.UTC(wall.y, wall.mo - 1, wall.d)).getUTCDay();
}

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};
const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1,
};
const DEFAULT_TIME = { h: 9, mi: 0 };       // a date with no time said
const DAYPART_TIME = { morning: { h: 8, mi: 0 }, afternoon: { h: 13, mi: 0 }, evening: { h: 18, mi: 0 }, night: { h: 20, mi: 0 } };

// ---------------------------------------------------------------------------
// parseDue — hand-rolled relative date/time parser.
// Returns { raw, iso, hasTime, spans } or null. `hasTime` is true only when
// a clock time, a daypart, noon/midnight, or the wake-up rule supplied one —
// it is what licenses a phone action. `spans` are [start,end] offsets into
// the input the engine strips out of item text once they become the due.
// ---------------------------------------------------------------------------
export function parseDue(text, { now = new Date(), timezone = 'America/Denver' } = {}) {
  const src = String(text || '');
  const low = lower(src);
  const wallNow = zonedParts(now, timezone);
  const spans = [];
  let date = null;   // {y, mo, d}
  let time = null;   // {h, mi}
  let hasTime = false;

  const grab = (re) => {
    const m = re.exec(low);
    if (m) spans.push([m.index, m.index + m[0].length]);
    return m;
  };

  // "when I wake up" — the prompt's own rule: ≈ 7:00 AM the next day.
  if (hasPhrase(low, 'when i wake up') || hasPhrase(low, 'when i get up')) {
    const m = /when i (?:wake|get) up/.exec(low);
    if (m) spans.push([m.index, m.index + m[0].length]);
    date = addDays(wallNow, 1);
    time = { h: 7, mi: 0 };
    hasTime = true;
  }

  // --- date part ---
  let m;
  if (!date && (m = grab(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/))) {
    date = { y: +m[1], mo: +m[2], d: +m[3] };
  }
  if (!date && (m = grab(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    let y = m[3] ? +m[3] : wallNow.y;
    if (y < 100) y += 2000;
    date = { y, mo: +m[1], d: +m[2] };
  }
  if (!date && (m = grab(new RegExp(`\\b(${Object.keys(MONTHS).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d\\d))?\\b`)))) {
    const mo = MONTHS[m[1]];
    let y = m[3] ? +m[3] : wallNow.y;
    // A named date already past this year means next year.
    if (!m[3] && (mo < wallNow.mo || (mo === wallNow.mo && +m[2] < wallNow.d))) y += 1;
    date = { y, mo, d: +m[2] };
  }
  if (!date && (m = grab(/\bend of (?:the )?month\b/))) {
    const last = new Date(Date.UTC(wallNow.y, wallNow.mo, 0)).getUTCDate();
    date = { y: wallNow.y, mo: wallNow.mo, d: last };
  }
  if (!date && (m = grab(/\bin\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an)\s+(day|days|week|weeks)\b/))) {
    const n = NUM_WORDS[m[1]] ?? +m[1];
    date = addDays(wallNow, m[2].startsWith('week') ? n * 7 : n);
  }
  if (!date && (m = grab(/\bnext week\b/))) date = addDays(wallNow, 7);
  if (!date && (m = grab(/\bnext month\b/))) {
    const t = new Date(Date.UTC(wallNow.y, wallNow.mo, wallNow.d));
    date = { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  if (!date && (m = grab(new RegExp(`\\b(next\\s+)?(${Object.keys(WEEKDAYS).join('|')})\\b`)))) {
    const target = WEEKDAYS[m[2]];
    let delta = (target - weekdayOf(wallNow) + 7) % 7;
    if (m[1]) delta += 7;
    date = addDays(wallNow, delta);
  }
  if (!date && (m = grab(/\bday after tomorrow\b/))) date = addDays(wallNow, 2);
  if (!date && (m = grab(/\btomorrow\b/))) date = addDays(wallNow, 1);
  if (!date && (m = grab(/\btonight\b/))) {
    date = { y: wallNow.y, mo: wallNow.mo, d: wallNow.d };
    if (!time) { time = DAYPART_TIME.evening; hasTime = true; }
  }
  if (!date && (m = grab(/\btoday\b/))) {
    date = { y: wallNow.y, mo: wallNow.mo, d: wallNow.d };
  }

  // --- time part ---
  if (!time && (m = grab(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/))) {
    let h = +m[1] % 12;
    if (/^p/.test(m[3])) h += 12;
    time = { h, mi: +(m[2] || 0) };
    hasTime = true;
  }
  if (!time && (m = grab(/\b(\d{1,2}):(\d{2})\b/))) {
    time = { h: +m[1], mi: +m[2] };
    hasTime = true;
  }
  if (!time && (m = grab(/\bnoon\b/))) { time = { h: 12, mi: 0 }; hasTime = true; }
  if (!time && (m = grab(/\bmidnight\b/))) { time = { h: 0, mi: 0 }; hasTime = true; }
  if (!time && (m = grab(/\b(morning|afternoon|evening|night)\b/))) {
    // A daypart only supplies a time when a date part exists to hang it on.
    if (date) { time = DAYPART_TIME[m[1]]; hasTime = true; }
  }
  if (!time && (m = grab(/\bat\s+(\d{1,2})\b/))) {
    const h = +m[1];
    time = { h: h >= 5 && h <= 11 ? h : h === 12 ? 12 : h + 12, mi: 0 };
    hasTime = true;
  }

  if (!date && !time) return null;
  if (!date) {
    // Time only: today if it is still ahead, otherwise tomorrow — the
    // reminder-app convention, and the only honest reading of "at 6:30"
    // said at 8 AM about something already past.
    date = { y: wallNow.y, mo: wallNow.mo, d: wallNow.d };
    if (time.h < wallNow.h || (time.h === wallNow.h && time.mi <= wallNow.mi)) {
      date = addDays(wallNow, 1);
    }
  }
  const t = time || DEFAULT_TIME;
  const iso = wallToIso({ ...date, h: t.h, mi: t.mi }, timezone);
  const raw = spans.length
    ? spans.sort((a, b) => a[0] - b[0]).map(([a, b]) => src.slice(a, b)).join(' ')
    : '';
  return { raw, iso, hasTime, spans };
}

// Strip the spans parseDue consumed (plus dangling punctuation) from text.
function stripSpans(text, spans) {
  if (!spans || !spans.length) return text;
  let out = text;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) {
    out = out.slice(0, a) + ' ' + out.slice(b);
  }
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/^[\s,;—-]+|[\s,;]+$/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// extractNumbers — currency, explicit ranges (two entries, one label), and
// number+unit quantities. `labelScope` (usually the whole sentence) is
// searched for the label when the clause itself doesn't carry one.
// ---------------------------------------------------------------------------
export function extractNumbers(text, { labelScope = null } = {}) {
  const src = String(text || '');
  const scope = labelScope || src;
  const out = [];
  const seen = new Set();
  const used = []; // [start,end] spans already claimed, in src coordinates

  const labelFor = (matchStart, matchEnd) => {
    // Prefer the first real noun AFTER the match ("48,000 pound load" —
    // the load is the thing measured; a unit word may still be the label).
    const after = src.slice(matchEnd).split(/\s+/).filter(Boolean).slice(0, 3);
    for (const w of after) {
      const clean = w.replace(/[^a-z-]/gi, '').toLowerCase();
      if (clean && !T.LABEL_STOPWORDS.includes(clean)) return clean;
    }
    // Else the noun phrase in the scope BEFORE the match starts (never
    // the match itself), trailing stopwords trimmed.
    const startInScope = scope === src ? matchStart : scope.indexOf(src) + matchStart;
    const before = scope.slice(0, Math.max(0, startInScope))
      .split(/\s+/)
      .map(w => w.replace(/[^a-z-]/gi, '').toLowerCase())
      .filter(Boolean);
    while (before.length && T.LABEL_STOPWORDS.includes(before[before.length - 1])) before.pop();
    // Measure words (pounds, bucks, miles…) in the tail are the PREVIOUS
    // number's unit, not this one's label. Count-nouns (ticket books,
    // loads) stay — they are genuine labels.
    const MEASURE_WORDS = ['pound', 'pounds', 'lb', 'lbs', 'dollar', 'dollars',
      'buck', 'bucks', 'mile', 'miles', 'km', 'hour', 'hours', 'hr', 'hrs',
      'minute', 'minutes', 'min', 'mins', 'gallon', 'gallons', 'gal', 'ton',
      'tons', 'foot', 'feet', 'ft', 'inch', 'inches', 'gb', 'mb', 'tb',
      'percent', 'acre', 'acres'];
    const tail = before.slice(-3)
      .filter(w => !T.LABEL_STOPWORDS.includes(w) && !MEASURE_WORDS.includes(w));
    return tail.join(' ') || 'value';
  };

  const push = (label, value, unit, span) => {
    const key = `${label}|${value}|${unit}`;
    if (seen.has(key) || !Number.isFinite(value)) return;
    seen.add(key);
    used.push(span);
    out.push({ label, value, unit, context: src.trim().slice(0, 160) });
  };
  const overlaps = (a, b) => used.some(([x, y]) => a < y && x < b);
  const num = (s) => Number(String(s).replace(/,/g, ''));

  // Currency: $1,234.56
  for (const m of src.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) {
    push(labelFor(m.index, m.index + m[0].length), num(m[1]), 'USD', [m.index, m.index + m[0].length]);
  }
  // Ranges: "60 to 100 bucks" → min and max sharing one label.
  const unitAlt = Object.keys(T.NUMBER_UNITS).map(escapeRe).join('|');
  const rangeRe = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s+to\\s+(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${unitAlt})\\b`, 'gi');
  for (const m of src.matchAll(rangeRe)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const unit = T.NUMBER_UNITS[lower(m[3])];
    const label = labelFor(m.index, m.index + m[0].length);
    push(label, num(m[1]), unit, [m.index, m.index + m[0].length]);
    push(label, num(m[2]), unit, [m.index, m.index + m[0].length]);
  }
  // Number + unit: "48,000 pounds", "3 loads"
  const unitRe = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${unitAlt})\\b`, 'gi');
  for (const m of src.matchAll(unitRe)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    push(labelFor(m.index, m.index + m[0].length), num(m[1]), T.NUMBER_UNITS[lower(m[2])],
      [m.index, m.index + m[0].length]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// classifyPriority
// ---------------------------------------------------------------------------
export function classifyPriority(text) {
  const lowText = lower(text);
  if (T.PRIORITY_HIGH_WORDS.some(w => hasPhrase(lowText, w))) return 'high';
  if (T.PRIORITY_LOW_WORDS.some(w => hasPhrase(lowText, w))) return 'low';
  return 'medium';
}

// ---------------------------------------------------------------------------
// Sentence + clause splitting
// ---------------------------------------------------------------------------
export function splitSentences(transcript) {
  return String(transcript || '')
    .replace(/\s*\n+\s*/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function splitClauses(sentence) {
  const connectors = [...T.ITEM_CONNECTORS].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `\\s*(?:;|,+\\s+and)\\s+|\\s+(?:${connectors.map(escapeRe).join('|')})\\s+`, 'i');
  const parts = [];
  let rest = sentence;
  // Manual scan so every clause knows whether it began at a connector.
  for (;;) {
    const m = pattern.exec(rest);
    if (!m) { parts.push(rest); break; }
    parts.push(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
    if (!rest) break;
  }
  return parts.map(p => p.trim()).filter(Boolean);
}

function tidyClause(clause) {
  let out = String(clause || '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    const lowText = lower(out);
    for (const f of [...T.LEADING_FILLER].sort((a, b) => b.length - a.length)) {
      if (lowText.startsWith(f + ' ') || lowText === f) {
        out = out.slice(f.length).replace(/^[\s,]+/, '');
        changed = true;
        break;
      }
    }
    for (const c of T.ITEM_CONNECTORS) {
      if (lower(out).startsWith(c + ' ')) {
        out = out.slice(c.length).replace(/^[\s,]+/, '');
        changed = true;
        break;
      }
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// People: known-list match (exact, then edit-distance-1 garble repair),
// then novel capitalized names mid-sentence.
// ---------------------------------------------------------------------------

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function matchPeople(text, knownPeople) {
  const people = [];
  const repairs = [];
  let working = String(text || '');

  for (const name of knownPeople) {
    if (!name || typeof name !== 'string') continue;
    const exact = new RegExp(`\\b${escapeRe(name)}\\b`, 'i');
    if (exact.test(working)) {
      if (!people.includes(name)) people.push(name);
      continue;
    }
    // Garble hunt: slide a same-word-count window over the text and look
    // for an edit distance of exactly 1 against the whole name.
    const words = working.split(/\s+/);
    const n = name.split(/\s+/).length;
    for (let i = 0; i + n <= words.length; i++) {
      const window = words.slice(i, i + n).join(' ');
      const clean = window.replace(/[^a-zA-Z' -]/g, '');
      if (clean.length >= 4 && editDistance(lower(clean), lower(name)) === 1) {
        repairs.push({
          heard: clean, meant: name,
          why: `one sound off a known person, "${name}"`,
        });
        working = working.replace(window, name);
        if (!people.includes(name)) people.push(name);
        break;
      }
    }
  }

  // Novel capitalized names — only in a person context (told, asked,
  // met with, called…). A bare capital mid-sentence is as likely to be a
  // dog ("Banner") or a company ("Banyan") as a person, and guessing
  // wrong puts a stranger in the people list; the flywheel tables can
  // widen this later. A capital at a sentence start proves nothing.
  const PERSON_CONTEXT = ['tell', 'ask', 'call', 'text', 'email', 'meet',
    'meeting', 'with', 'from', 'thank', 'thanks', 'mr', 'mrs', 'dr', 'per'];
  const sentences = splitSentences(working);
  for (const s of sentences) {
    const words = s.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const m = /^([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?$/.exec(
        words[i].replace(/[^A-Za-z' -]/g, '') +
        (words[i + 1] && /^[A-Z]/.test(words[i + 1]) ? ' ' + words[i + 1].replace(/[^A-Za-z'-]/g, '') : ''));
      if (!m) continue;
      const cand = m[2] ? `${m[1]} ${m[2]}` : m[1];
      if (T.NOT_PEOPLE.includes(lower(m[1])) || T.NOT_PEOPLE.includes(lower(cand))) continue;
      const prev = words.slice(Math.max(0, i - 2), i)
        .map(w => lower(w.replace(/[^a-z]/g, '')));
      if (!prev.some(w => PERSON_CONTEXT.includes(w))) continue;
      if (!people.includes(cand)) people.push(cand);
    }
  }
  return { people, repairs, workingText: working };
}

// ---------------------------------------------------------------------------
// Project scoring against the caller's own project list (label + hint are
// data designed for matching).
// ---------------------------------------------------------------------------

function scoreProject(clauseLow, project) {
  const words = new Set(
    `${project.slug} ${project.label || ''} ${project.hint || ''}`
      .split(/[^a-z0-9]+/i).map(w => stem(lower(w))).filter(w => w.length >= 3));
  let score = 0;
  for (const tok of tokenize(clauseLow)) if (words.has(stem(tok))) score++;
  if (clauseLow.includes(lower(project.slug).replace(/-/g, ' '))) score += 3;
  if (project.label && clauseLow.includes(lower(project.label))) score += 3;
  return score;
}

// ---------------------------------------------------------------------------
// organizeWithRules — the engine. Returns the WIRE shape (empty strings for
// absent values, exactly as EXTRACTION_JSON_SCHEMA declares); extract.js's
// normalizeEntry() turns that into the stored shape.
// ---------------------------------------------------------------------------
export function organizeWithRules({
  transcript,
  projects = SEED_PROJECTS,
  tags = [],
  people = [],
  nowIso = new Date().toISOString(),
  timezone = 'America/Denver',
} = {}) {
  const now = new Date(nowIso);
  const projectList = Array.isArray(projects) && projects.length ? projects : SEED_PROJECTS;
  const existingTags = Array.isArray(tags) ? tags : [];

  let working = String(transcript || '').trim();
  const repairs = [];

  // Fixed-phrase garbles (tables) — applied before anything else reads it.
  for (const { heard, meant } of T.GARBLE_REPAIRS) {
    const re = new RegExp(escapeRe(heard), 'i');
    if (re.test(working)) {
      repairs.push({ heard, meant, why: 'known dictation garble' });
      working = working.replace(new RegExp(escapeRe(heard), 'gi'), meant);
    }
  }

  const peopleMatch = matchPeople(working, Array.isArray(people) ? people : []);
  working = peopleMatch.workingText;
  repairs.push(...peopleMatch.repairs);

  const sentences = splitSentences(working);
  const items = [];
  const numbers = [];
  const openQuestions = [];
  const unclear = [];
  const accounted = new Set(); // sentence indexes that produced an item

  sentences.forEach((sentence, sIdx) => {
    numbers.push(...extractNumbers(sentence, { labelScope: sentence }));

    const cleanSentence = sentence.replace(/[.!?]+$/, '').trim();
    if (T.FILLER_SENTENCES.includes(lower(cleanSentence))) {
      accounted.add(sIdx);
      return;
    }

    // The sentence's own due (a deadline said once at the end covers the
    // clauses in front of it); a clause's own due overrides it.
    const sentenceDue = parseDue(sentence, { now, timezone });

    let lastItem = null;
    for (const rawClause of splitClauses(sentence)) {
      const clause = tidyClause(rawClause);
      if (!clause) continue;
      const clauseLow = lower(clause);

      // Detail clauses attach to the previous item instead of splitting.
      if (lastItem && T.DETAIL_STARTERS.some(d => clauseLow.startsWith(d + ' '))) {
        lastItem.detail = lastItem.detail
          ? `${lastItem.detail} ${clause}` : clause;
        accounted.add(sIdx);
        continue;
      }

      const verbs = contentVerbsIn(clause);
      const isQuestion = /\?\s*$/.test(clause) ||
        T.QUESTION_STARTERS.includes(tokenize(clause)[0] || '') ||
        T.QUESTION_PHRASES.some(p => hasPhrase(clauseLow, p));
      const projectScores = projectList.map(p => scoreProject(clauseLow, p));
      const bestProject = Math.max(0, ...projectScores);
      const hasNumber = /\d/.test(clause);
      const namesPerson = peopleMatch.people.some(p => hasPhrase(clauseLow, lower(p)));

      // COVERAGE GATE: nothing recognizable → unclear, verbatim. The
      // engine does not invent an item to make the dump look tidy.
      if (!verbs.length && !isQuestion && !hasNumber && bestProject === 0 && !namesPerson) {
        if (!unclear.includes(sentence)) unclear.push(sentence);
        continue;
      }

      // --- kind ---
      let kind = 'note';
      if (isQuestion) kind = 'question';
      else if (T.DECISION_PHRASES.some(p => hasPhrase(clauseLow, p))) kind = 'decision';
      else if (T.BLOCKER_PHRASES.some(p => hasPhrase(clauseLow, p))) kind = 'blocker';
      else if (T.IDEA_PHRASES.some(p => hasPhrase(clauseLow, p))) kind = 'idea';
      else if (verbs.some(v => T.PURCHASE_VERBS.includes(v))) kind = 'purchase';
      else if (T.PAST_REPORT_STARTERS.some(p => clauseLow.startsWith(p))) kind = 'note';
      else {
        // A clause LED by a past-tense verb is a report of what already
        // happened → note, even when the verb is also a task verb ("Took
        // Banner to the vet"). Same-form verbs (set/put/cut/read) are
        // ambiguous and never read as past on their own.
        const firstVerbToken = tokenize(clause).find(tok => VERB_FORMS.has(tok));
        const AMBIGUOUS = ['set', 'put', 'cut', 'read', 'hit'];
        const ledByPast = firstVerbToken && !AMBIGUOUS.includes(firstVerbToken) &&
          (Object.hasOwn(T.IRREGULAR_VERB_FORMS, firstVerbToken) || /ed$/.test(firstVerbToken));
        if (ledByPast && !hasPhrase(clauseLow, 'need to') && !hasPhrase(clauseLow, 'have to')) {
          kind = 'note';
        } else if (verbs.some(v => T.TASK_VERBS.includes(v)) ||
                   hasPhrase(clauseLow, 'need to') || hasPhrase(clauseLow, 'have to') ||
                   hasPhrase(clauseLow, 'remind me')) {
          kind = 'task';
        }
      }

      // --- due + phone action (no time → no action, ever) ---
      const clauseDue = parseDue(clause, { now, timezone });
      const due = clauseDue || sentenceDue;
      let phone_action = { kind: 'none', title: '', when_iso: '', duration_min: 0 };
      const wantsReminder = T.REMINDER_TRIGGERS.some(p => hasPhrase(clauseLow, p));
      const isMeeting = T.MEETING_WORDS.some(p => hasPhrase(clauseLow, p));
      if (due && due.hasTime && (wantsReminder || isMeeting)) {
        let duration = 0;
        if (/\bfor\s+(?:an?\s+)?half\s+(?:an\s+)?hour\b/.test(clauseLow)) duration = 30;
        else if (/\bfor\s+an?\s+hour\b/.test(clauseLow)) duration = 60;
        else {
          const hM = /\bfor\s+(\d+|one|two|three|four)\s*(?:hours?|hrs?)\b/.exec(clauseLow);
          const mM = /\bfor\s+(\d+)\s*(?:minutes?|mins?)\b/.exec(clauseLow);
          if (hM) duration = (NUM_WORDS[hM[1]] ?? +hM[1]) * 60;
          else if (mM) duration = +mM[1];
        }
        phone_action = {
          kind: isMeeting ? 'calendar_event' : 'reminder',
          title: '',
          when_iso: due.iso,
          duration_min: isMeeting ? (duration || 30) : duration,
        };
      }

      // --- text: their words, minus the time phrase that became the due ---
      let text = clause;
      if (due) text = stripSpans(text, due.spans);
      text = text.replace(/\s+/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '').trim();
      if (!text) text = clause;
      if (!/[.!?]$/.test(text)) text += '.';
      if (phone_action.kind !== 'none') phone_action.title = text.replace(/\.$/, '');

      // --- tags: tables first, then reuse of the user's existing tags ---
      const itemTags = [];
      for (const [kw, tag] of Object.entries(T.TAG_KEYWORDS)) {
        if (hasPhrase(clauseLow, kw) && !itemTags.includes(tag)) itemTags.push(tag);
      }
      for (const t of existingTags) {
        const slug = lower(t).replace(/[^a-z0-9]+/g, '-');
        if (slug && hasPhrase(clauseLow, lower(t)) && !itemTags.includes(slug)) itemTags.push(slug);
      }

      const projectIdx = projectScores.indexOf(bestProject);
      const item = {
        kind,
        text,
        detail: '',
        project: bestProject > 0 ? projectList[projectIdx].slug : 'personal',
        project_is_new: false,
        tags: itemTags.slice(0, 12),
        priority: classifyPriority(clause),
        due: due ? { raw: due.raw, iso: due.iso } : { raw: '', iso: '' },
        phone_action,
        _sentence: sIdx,
      };
      items.push(item);
      lastItem = item;
      accounted.add(sIdx);
      if (kind === 'question') openQuestions.push(text.replace(/\.$/, '') + '?');
    }

    if (!accounted.has(sIdx) && !unclear.includes(sentence)) {
      // A sentence that produced nothing and wasn't filler: it still gets
      // its unclear line rather than vanishing (splitClauses edge cases).
      if (!items.some(i => i._sentence === sIdx)) unclear.push(sentence);
    }
  });

  const topics = items.map(i => i.text.replace(/\.$/, '').split(/\s+/).slice(0, 7).join(' '));
  const title = topics.length
    ? (topics[0].charAt(0).toUpperCase() + topics[0].slice(1)).slice(0, 200)
    : 'Untitled entry';
  const summary = items.length === 0 ? ''
    : items.length === 1 ? items[0].text
    : `${items.length} items: ${items.slice(0, 2).map(i => i.text.replace(/\.$/, '')).join('; ')}.`;

  return {
    topics,
    title,
    summary,
    items: items.map(({ _sentence, ...rest }) => rest),
    people: peopleMatch.people,
    numbers,
    open_questions: openQuestions,
    transcription_repairs: repairs,
    unclear,
    image_has_text: false,
    image_text: '',
    image_description: '',
  };
}

// ---------------------------------------------------------------------------
// The provider — same call() contract as the vendors in providers.js.
// The transcript arrives wrapped by extract.js ("Brain dump (spoken):\n\"\"\"…\"\"\"");
// unwrap it. An attached photo is NOT read (rules cannot OCR): image_text
// stays empty and normalizeEntry() records the photo as unread, honestly.
// ---------------------------------------------------------------------------
function unwrapTranscript(text) {
  const s = String(text || '');
  const first = s.indexOf('"""');
  const last = s.lastIndexOf('"""');
  if (first !== -1 && last > first) return s.slice(first + 3, last).trim();
  if (s.startsWith('No audio was recorded')) return '';
  return s.trim();
}

export const rulesProvider = {
  name: 'rules',
  async call({ text, context } = {}) {
    const entry = organizeWithRules({
      transcript: unwrapTranscript(text),
      ...(context && typeof context === 'object' ? context : {}),
    });
    return { text: JSON.stringify(entry), stopReason: 'stop' };
  },
};
