// lib/actionable/rules-tables.js
// ---------------------------------------------------------------------------
// THE WORD TABLES for the local rules organizer (lib/actionable/rules.js).
//
// This file is DATA ONLY — no logic. Every classification the rules engine
// makes is a lookup against one of these tables, which is the whole point:
// when the flywheel (Bite B shadow tuning, then real corrections) finds the
// engine mis-sorting Troy's dictation, the fix lands HERE as new words in a
// table, not as new code. If you are about to write an `if` that mentions a
// specific word, it belongs in this file instead.
//
// Seeded from the vocabulary in lib/actionable/prompt.js (the real sample
// dumps) and Troy's working domains: dairy hauling, flatbed freight, and the
// software businesses. Extend freely; keep entries lowercase.
// ---------------------------------------------------------------------------

// --- Priority ---------------------------------------------------------------
// A hit on HIGH forces priority "high"; a hit on LOW (with no HIGH hit)
// yields "low"; otherwise "medium". Mirrors the prompt law: high only on
// urgency, a hard deadline, money at risk, or somebody waiting.
export const PRIORITY_HIGH_WORDS = [
  'urgent', 'asap', 'right away', 'immediately', 'critical', 'emergency',
  'overdue', 'deadline', 'waiting on', 'waiting for', 'at risk',
  'must', 'has to be done', 'needs to be done', 'today', 'tonight',
  'before noon', 'before close', 'first thing', 'top priority',
];

export const PRIORITY_LOW_WORDS = [
  'someday', 'eventually', 'no rush', 'when i get a chance',
  'whenever', 'background', 'down the road', 'at some point',
  'nice to have', 'low priority', 'not urgent',
];

// --- Item kind signals --------------------------------------------------------
// Checked in the order: question, decision, blocker, idea, purchase, then
// past-tense report (note), then task verbs, then note as the honest default
// for a clause that still carries a known content verb.
export const DECISION_PHRASES = [
  'decided', 'we decided', 'i decided', 'decision is', "let's go with",
  'lets go with', 'going with', 'agreed to', 'signed off', "it's yours",
  'its yours', "i'm out", 'im out', 'we agreed', 'settled on',
];

export const IDEA_PHRASES = [
  'idea', 'what if', 'maybe we could', 'maybe i should', 'thinking about',
  'thought about', 'someday i want', 'want to build', 'would be nice',
  'could build', 'could make', 'wonder if',
];

export const BLOCKER_PHRASES = [
  'blocked', "can't", 'cant', 'cannot', 'stuck', 'waiting on the',
  'held up', 'on hold', 'until it clears', 'until that clears',
  'no way to', 'down until', 'broken', 'out of service',
];

export const PURCHASE_VERBS = [
  'buy', 'order', 'purchase', 'pick up', 'grab', 'restock', 'renew',
];

export const QUESTION_STARTERS = [
  'what', 'when', 'where', 'who', 'why', 'how', 'is', 'are', 'do', 'does',
  'did', 'can', 'could', 'should', 'would', 'have', 'has',
];

export const QUESTION_PHRASES = [
  'need to ask', 'need to find out', 'find out', 'ask him', 'ask her',
  'ask them', 'not sure', "don't know", 'dont know', 'wondering',
];

// Past-tense report openers — "something already DONE" is a note, per the
// prompt law. Matched at clause start (after connector stripping).
export const PAST_REPORT_STARTERS = [
  'i took', 'i texted', 'i called', 'i checked', 'i picked', 'i dropped',
  'i delivered', 'i hauled', 'i loaded', 'i unloaded', 'i finished',
  'i sent', 'i paid', 'i met', 'i talked', 'i spoke', 'i went', 'i got',
  'i received', 'i submitted', 'i filed', 'i fixed', 'i cleaned',
  'took the', 'picked up the', 'dropped off', 'just finished',
  'just got back', 'already done', 'done with',
];

// --- Verbs --------------------------------------------------------------------
// The coverage gate: a clause becomes an item only if it carries one of
// these content verbs (or a number, or a question form, or a project/people
// hit). Auxiliaries (is/was/has…) deliberately do NOT count — a sentence
// with no content verb is a sentence the engine cannot honestly structure,
// so it goes to `unclear` verbatim instead of becoming an invented item.
// Base forms; rules.js expands regular inflections (-s/-es/-ed/-ing) and
// the IRREGULAR_VERB_FORMS map below.
export const CONTENT_VERBS = [
  'call', 'text', 'email', 'tell', 'ask', 'check', 'send', 'take', 'get',
  'remind', 'paint', 'repaint',
  'buy', 'order', 'pick', 'drop', 'deliver', 'haul', 'load', 'unload',
  'wash', 'scale', 'dump', 'pump', 'milk', 'feed', 'fix', 'repair',
  'clean', 'finish', 'start', 'build', 'make', 'write', 'read', 'review',
  'schedule', 'book', 'pay', 'file', 'submit', 'sign', 'approve', 'test',
  'ship', 'deploy', 'install', 'update', 'set', 'move', 'bring', 'carry',
  'hook', 'trace', 'track', 'count', 'weigh', 'record', 'note', 'plan',
  'meet', 'talk', 'speak', 'visit', 'drive', 'run', 'work', 'help',
  'show', 'give', 'hand', 'pass', 'open', 'close', 'stop', 'wait',
  'need', 'want', 'try', 'use', 'add', 'remove', 'change', 'confirm',
  'verify', 'print', 'scan', 'charge', 'bill', 'quote', 'bid', 'book',
  'reserve', 'renew', 'cancel', 'register', 'apply', 'collect', 'store',
  'keep', 'leave', 'put', 'cut', 'tie', 'strap', 'chain', 'tarp',
  'inspect', 'grease', 'fuel', 'park', 'back', 'pull', 'push', 'lift',
  'rinse', 'sanitize', 'sample', 'tag', 'label', 'sort', 'stack',
];

export const IRREGULAR_VERB_FORMS = {
  took: 'take', told: 'tell', sent: 'send', went: 'go', got: 'get',
  made: 'make', wrote: 'write', read: 'read', spoke: 'speak',
  drove: 'drive', ran: 'run', gave: 'give', paid: 'pay',
  met: 'meet', left: 'leave', put: 'put', cut: 'cut', set: 'set',
  brought: 'bring', bought: 'buy', thought: 'think', found: 'find',
  kept: 'keep', began: 'begin', broke: 'break', chose: 'choose',
  did: 'do', done: 'do', said: 'say', saw: 'see', knew: 'know',
};

// Task verbs — a clause whose first content verb is one of these (or which
// carries "need to / have to / remind me") is kind "task" when no stronger
// kind signal fired. A superset relationship with CONTENT_VERBS is fine.
export const TASK_VERBS = [
  'call', 'text', 'email', 'tell', 'check', 'send', 'take', 'buy',
  'order', 'pick', 'schedule', 'book', 'pay', 'file', 'submit', 'sign',
  'approve', 'fix', 'repair', 'clean', 'finish', 'build', 'write',
  'review', 'test', 'ship', 'install', 'update', 'set', 'move', 'bring',
  'deliver', 'haul', 'load', 'unload', 'wash', 'inspect', 'confirm',
  'print', 'collect', 'renew', 'cancel', 'apply', 'record', 'count',
  'weigh', 'hook', 'trace', 'grease', 'fuel', 'sample', 'tag',
];

// --- Item splitting -------------------------------------------------------------
// A sentence splits into separate items at these connectors when the right
// side can stand as its own clause. Detail starters never split — they
// attach to the previous item as its `detail`.
export const ITEM_CONNECTORS = [
  'and then', 'and also', 'also', 'plus', 'then',
];

export const DETAIL_STARTERS = [
  'because', 'since', 'so that', 'which', 'so', 'but', 'except',
];

// Whole-sentence filler: accounted for and dropped, never an item, never
// unclear. Matched after lowercasing and stripping punctuation.
export const FILLER_SENTENCES = [
  'you know what i mean', 'you know', 'i mean', 'anyway', 'anyways',
  'okay', 'ok', 'yeah', 'right', 'so yeah', 'and yeah', 'um', 'uh',
  'let me think', "that's it", 'thats it', 'that is it', 'never mind',
  'forget it', 'hello', 'hey',
];

// Leading filler stripped from the front of a clause before it becomes
// item text.
export const LEADING_FILLER = [
  'okay so', 'okay', 'so', 'and so', 'well', 'now', 'hey', 'yeah so',
  'alright so', 'all right so', 'alright', 'listen',
];

// --- Phone actions ----------------------------------------------------------------
export const REMINDER_TRIGGERS = [
  'remind me', 'reminder', 'set an alarm', 'set a reminder',
  'wake me', 'alarm for',
];

export const MEETING_WORDS = [
  'meeting', 'appointment', 'call with', 'lunch with', 'dinner with',
  'visit with', 'meet with', 'meet at', 'interview', 'demo with',
  'walkthrough', 'training with',
];

// --- Numbers ------------------------------------------------------------------------
// Unit word → emitted unit label. Numbers are only extracted with one of
// these units, a $ amount, or an explicit range — a bare digit string in a
// dictation is as likely to be a time or a date as a measurement.
export const NUMBER_UNITS = {
  dollar: 'USD', dollars: 'USD', bucks: 'USD', buck: 'USD',
  mile: 'miles', miles: 'miles', mi: 'miles',
  km: 'km', kilometer: 'km', kilometers: 'km',
  hour: 'hours', hours: 'hours', hr: 'hours', hrs: 'hours',
  minute: 'minutes', minutes: 'minutes', min: 'minutes', mins: 'minutes',
  gb: 'GB', mb: 'MB', tb: 'TB',
  pound: 'pounds', pounds: 'pounds', lb: 'pounds', lbs: 'pounds',
  gallon: 'gallons', gallons: 'gallons', gal: 'gallons',
  ton: 'tons', tons: 'tons',
  foot: 'feet', feet: 'feet', ft: 'feet',
  inch: 'inches', inches: 'inches',
  percent: 'percent', '%': 'percent',
  head: 'head', cow: 'count', cows: 'count',
  load: 'loads', loads: 'loads',
  acre: 'acres', acres: 'acres',
  dozen: 'dozen',
  case: 'cases', cases: 'cases',
  pallet: 'pallets', pallets: 'pallets',
  ticket: 'count', tickets: 'count',
  book: 'count', books: 'count',
};

// Words that may not end a number's label (the label is the short noun
// phrase in front of the number, trimmed of these).
export const LABEL_STOPWORDS = [
  'the', 'a', 'an', 'of', 'was', 'is', 'were', 'are', 'about', 'around',
  'roughly', 'almost', 'over', 'under', 'to', 'for', 'at', 'on', 'in',
  'with', 'and', 'or', 'that', 'this', 'it', 'they', 'we', 'i', 'he',
  'she', 'said', 'says', 'run', 'runs', 'cost', 'costs', 'weighs',
];

// --- Tags -------------------------------------------------------------------------
// Keyword → tag. First hit wins per tag; tags are emitted slug-style and
// normalizeEntry() slugifies again, so spaces are fine here.
export const TAG_KEYWORDS = {
  nda: 'nda', 'non-disclosure': 'nda',
  vet: 'animals', dog: 'animals', cat: 'animals', horse: 'animals',
  invoice: 'billing', billing: 'billing', payment: 'billing',
  permit: 'compliance', inspection: 'compliance', compliance: 'compliance',
  wash: 'wash-tags', 'wash tag': 'wash-tags', 'wash tags': 'wash-tags',
  insurance: 'insurance', filing: 'admin', paperwork: 'admin',
  pump: 'equipment', valve: 'equipment', hose: 'equipment',
  trailer: 'equipment', truck: 'equipment', rig: 'equipment',
  animation: 'animation', rigging: 'animation', blender: 'animation',
  coil: 'coils', coils: 'coils', flatbed: 'flatbed', tarp: 'flatbed',
  'tie down': 'securement', tiedown: 'securement', strap: 'securement',
  chain: 'securement',
  plant: 'plant', 'co-op': 'plant', coop: 'plant', dairy: 'dairy',
  milk: 'dairy', silo: 'dairy', tanker: 'dairy',
  demo: 'demo', pricing: 'pricing', sales: 'sales', customer: 'sales',
  app: 'software', software: 'software', deploy: 'software',
  meeting: 'meeting', call: 'calls',
};

// --- People spotting ------------------------------------------------------------------
// Capitalized words that are not people (months, weekdays, sentence furniture).
export const NOT_PEOPLE = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sunday', 'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'today', 'tomorrow', 'tonight', 'morning', 'afternoon', 'evening',
  'i', 'the', 'a', 'an', 'and', 'but', 'so', 'if', 'when', 'what',
];

// --- Transcription repairs --------------------------------------------------------------
// Whole-phrase garbles already proven on this user's dictation (from
// prompt.js's real examples). Known-name repairs (people/projects) are
// computed in rules.js against the caller's own lists; this table is only
// for fixed phrases. heard → meant.
export const GARBLE_REPAIRS = [
  { heard: 'local LL Mississippi', meant: 'local LLMs' },
  { heard: 'LL Mississippi', meant: 'LLMs' },
];
