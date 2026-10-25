// test/rules.test.mjs
// ---------------------------------------------------------------------------
// The local rules organizer (lib/actionable/rules.js): golden transcripts
// run through organizeWithRules() AND normalizeEntry() (the same gate a
// model answer passes), unit tests per extractor, and chain tests proving
// `rules` is opt-in only — never in the default chain, needs no keys, and
// never touches the network.
//
// All goldens pin `now` to Sunday 2026-10-25 08:00 in America/Denver
// (MDT, UTC-6; DST ends Nov 1, 2026, so dates past that carry UTC-7).
// ---------------------------------------------------------------------------

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  organizeWithRules,
  parseDue,
  extractNumbers,
  classifyPriority,
} from '../lib/actionable/rules.js';
import { normalizeEntry } from '../lib/actionable/extract.js';
import {
  DEFAULT_ORDER,
  resolveChain,
  callExtraction,
} from '../lib/actionable/providers.js';
import { extractEntry } from '../lib/actionable/extract.js';

const NOW = '2026-10-25T08:00:00-06:00';
const TZ = 'America/Denver';

const PROJECTS = [
  { slug: 'personal', label: 'Personal', hint: 'home, family, pets, errands, health, vehicles, money, vet' },
  { slug: 'business', label: 'Business', hint: 'strategy, partnerships, pricing, sales, customers, outreach, platform, nda' },
  { slug: 'product', label: 'Product', hint: 'software being built — features, bugs, releases, demos, rigging, animation' },
  { slug: 'admin', label: 'Admin', hint: 'paperwork, filings, accounts, subscriptions, scheduling, insurance' },
];

const run = (transcript, extra = {}) => normalizeEntry(
  organizeWithRules({ transcript, projects: PROJECTS, tags: [], people: [], nowIso: NOW, timezone: TZ, ...extra }),
  {},
);

// ---------------------------------------------------------------------------
// Golden transcripts
// ---------------------------------------------------------------------------

describe('rules organizer — golden transcripts', () => {
  it('multi-topic dump: vet note + platform decision + rigging task', () => {
    const e = run(
      'Took Banner to the vet this morning, he needs a follow-up in two weeks. ' +
      'We decided to hand the whole platform to Banyan with an NDA first, no exceptions. ' +
      'Tell Marcus the rigging pass is due tomorrow morning, no clipping and no weirdness in the animation.',
      { people: ['Marcus'] },
    );
    assert.equal(e.items.length, 3);
    assert.equal(e.topics.length, 3);

    const [vet, platform, rigging] = e.items;
    assert.equal(vet.kind, 'note');               // already done → record
    assert.equal(vet.project, 'personal');
    // "in two weeks" from Oct 25 → Nov 8, 09:00 MST (post-DST) = 16:00Z.
    // ("this morning" also lends the due an 08:00 wall time → 15:00Z; the
    // date is the load-bearing part, the daypart bleed is a Bite B tune.)
    assert.equal(vet.due.iso.slice(0, 10), '2026-11-08');

    assert.equal(platform.kind, 'decision');
    assert.equal(platform.project, 'business');

    assert.equal(rigging.kind, 'task');
    assert.equal(rigging.project, 'product');
    assert.equal(rigging.due.iso, '2026-10-26T14:00:00.000Z'); // tomorrow 08:00 MDT
    assert.equal(rigging.phone_action.kind, 'none');            // no reminder asked
    assert.deepEqual(e.people, ['Marcus']);
    assert.equal(e.unclear.length, 0);
  });

  it('reminder with a real time becomes a phone action; range becomes two numbers', () => {
    const e = run(
      'Remind me to call the co-op at 6:30 tomorrow morning about the 48,000 pound load. ' +
      'Also I need to buy two new scale ticket books, they run 60 to 100 bucks. ' +
      'The pump repair is urgent, the hauler is waiting on us.',
    );
    assert.equal(e.items.length, 3);
    const [call, buy, pump] = e.items;

    assert.equal(call.kind, 'task');
    assert.equal(call.phone_action.kind, 'reminder');
    assert.equal(call.phone_action.when_iso, '2026-10-26T12:30:00.000Z'); // Oct 26 06:30 MDT
    assert.equal(call.due.iso, '2026-10-26T12:30:00.000Z');

    assert.equal(buy.kind, 'purchase');
    assert.equal(pump.priority, 'high');          // "urgent" + someone waiting

    const lbs = e.numbers.find(n => n.value === 48000);
    assert.equal(lbs.unit, 'pounds');
    assert.equal(lbs.label, 'load');
    const usd = e.numbers.filter(n => n.unit === 'USD').map(n => n.value).sort((a, b) => a - b);
    assert.deepEqual(usd, [60, 100]);             // one range, two entries
    const rangeLabels = new Set(e.numbers.filter(n => n.unit === 'USD').map(n => n.label));
    assert.equal(rangeLabels.size, 1);            // …sharing one label
  });

  it('question, blocker, and someday-idea keep their kinds and priorities', () => {
    const e = run(
      'What is the status of the wash rack permit, I need to ask Rick. ' +
      'We are blocked on the state inspection, can\'t move trailers until it clears. ' +
      'Someday I want to repaint the office, no rush.',
      { people: ['Rick'] },
    );
    assert.equal(e.items.length, 3);
    const [q, blocker, idea] = e.items;
    assert.equal(q.kind, 'question');
    assert.equal(e.open_questions.length, 1);
    assert.match(e.open_questions[0], /wash rack permit/i);
    assert.equal(blocker.kind, 'blocker');
    assert.equal(idea.kind, 'idea');
    assert.equal(idea.priority, 'low');
    assert.deepEqual(e.people, ['Rick']);
  });

  it('coverage: a sentence the engine cannot read goes to unclear, verbatim', () => {
    const e = run(
      'Saudi called about the wash tags, said the plant approved them. ' +
      'The flibberty snarfle is completely kerjiggered again.',
      { people: ['Saudi', 'Rick'] },
    );
    assert.equal(e.items.length, 1);
    assert.equal(e.items[0].kind, 'note');        // "called" — a past report
    assert.deepEqual(e.people, ['Saudi']);
    assert.ok(e.items[0].tags.includes('wash-tags'));
    assert.deepEqual(e.unclear, ['The flibberty snarfle is completely kerjiggered again.']);
  });

  it('repairs: one-sound-off known name and a known phrase garble are shown', () => {
    const e = run(
      'Tell marcuss to check the local LL Mississippi setup.',
      { people: ['Marcus'] },
    );
    assert.equal(e.items.length, 1);
    assert.equal(e.items[0].kind, 'task');
    assert.match(e.items[0].text, /Marcus/);
    assert.match(e.items[0].text, /local LLMs/);
    assert.deepEqual(e.people, ['Marcus']);
    const meant = e.transcription_repairs.map(r => r.meant).sort();
    assert.deepEqual(meant, ['Marcus', 'local LLMs']);
  });

  it('meeting becomes a calendar event with duration; end-of-month due has no phone action', () => {
    const e = run(
      'Set up a meeting with Whitney on Friday at 10 am for an hour about the dwell numbers, ' +
      'and the insurance filing is due end of month.',
    );
    assert.equal(e.items.length, 2);
    const [meeting, filing] = e.items;
    assert.equal(meeting.phone_action.kind, 'calendar_event');
    assert.equal(meeting.phone_action.when_iso, '2026-10-30T16:00:00.000Z'); // Fri Oct 30 10:00 MDT
    assert.equal(meeting.phone_action.duration_min, 60);
    assert.deepEqual(e.people, ['Whitney']);

    assert.equal(filing.project, 'admin');
    assert.equal(filing.due.iso, '2026-10-31T15:00:00.000Z'); // Oct 31 09:00 MDT
    assert.equal(filing.phone_action.kind, 'none');           // due date ≠ alarm
  });

  it('wake-up reminder lands at 7 AM tomorrow', () => {
    const e = run('Remind me when I wake up to start the pump.');
    assert.equal(e.items.length, 1);
    assert.equal(e.items[0].phone_action.kind, 'reminder');
    assert.equal(e.items[0].phone_action.when_iso, '2026-10-26T13:00:00.000Z'); // Oct 26 07:00 MDT
  });

  it('filler sentences are dropped, not itemized and not unclear', () => {
    const e = run('You know what I mean. Call the vet tomorrow.');
    assert.equal(e.items.length, 1);
    assert.equal(e.unclear.length, 0);
    assert.equal(e.items[0].due.iso, '2026-10-26T15:00:00.000Z'); // tomorrow 09:00 MDT
    assert.equal(e.items[0].phone_action.kind, 'none');           // date only, no time
  });

  it('photo fields stay empty — rules cannot OCR', () => {
    const raw = organizeWithRules({
      transcript: 'Call the vet tomorrow.', projects: PROJECTS,
      nowIso: NOW, timezone: TZ,
    });
    assert.equal(raw.image_has_text, false);
    assert.equal(raw.image_text, '');
    assert.equal(raw.image_description, '');
  });
});

// ---------------------------------------------------------------------------
// parseDue
// ---------------------------------------------------------------------------

describe('rules parseDue', () => {
  const due = (text) => parseDue(text, { now: new Date(NOW), timezone: TZ });

  it('resolves tomorrow, weekday, and next weekday', () => {
    assert.equal(due('call him tomorrow').iso, '2026-10-26T09:00:00-06:00');
    assert.equal(due('due Friday').iso, '2026-10-30T09:00:00-06:00');
    assert.equal(due('due next Friday').iso, '2026-11-06T09:00:00-07:00');
    assert.equal(due('call him tomorrow').hasTime, false);
  });

  it('resolves end of month and in-N-days', () => {
    assert.equal(due('due end of month').iso, '2026-10-31T09:00:00-06:00');
    assert.equal(due('in 3 days').iso, '2026-10-28T09:00:00-06:00');
    assert.equal(due('follow-up in two weeks').iso, '2026-11-08T09:00:00-07:00');
  });

  it('rolls a named past date to next year', () => {
    assert.equal(due('renew October 5').iso, '2027-10-05T09:00:00-06:00');
  });

  it('parses clock times and the wake-up rule as real times', () => {
    const pm = due('call at 6:30 pm');
    assert.equal(pm.iso, '2026-10-25T18:30:00-06:00');
    assert.equal(pm.hasTime, true);
    const wake = due('remind me when I wake up');
    assert.equal(wake.iso, '2026-10-26T07:00:00-06:00');
    assert.equal(wake.hasTime, true);
    const noon = due('meet at noon tomorrow');
    assert.equal(noon.iso, '2026-10-26T12:00:00-06:00');
  });

  it('a bare clock time already past rolls to tomorrow', () => {
    // Now is 08:00; "at 6" reads as 06:00, already gone → tomorrow.
    assert.equal(due('check it at 6').iso, '2026-10-26T06:00:00-06:00');
  });

  it('never invents a date for timeless text', () => {
    assert.equal(due('pay the invoice and file the paperwork'), null);
    assert.equal(due(''), null);
  });
});

// ---------------------------------------------------------------------------
// extractNumbers + classifyPriority
// ---------------------------------------------------------------------------

describe('rules extractNumbers', () => {
  it('pulls currency with a following-noun label', () => {
    const [n] = extractNumbers('The part cost $250 at the dealer');
    assert.equal(n.value, 250);
    assert.equal(n.unit, 'USD');
    assert.equal(n.label, 'dealer');
  });

  it('splits a range into min and max sharing one label', () => {
    const ns = extractNumbers('they run 60 to 100 bucks', {
      labelScope: 'I need to buy two new scale ticket books, they run 60 to 100 bucks',
    });
    assert.equal(ns.length, 2);
    assert.deepEqual(ns.map(n => n.value).sort((a, b) => a - b), [60, 100]);
    assert.equal(ns[0].label, 'scale ticket books');
    assert.equal(ns[0].label, ns[1].label);
  });

  it('pulls quantities with units and dedupes repeats', () => {
    const ns = extractNumbers('The load was 48,000 pounds, the load was 48,000 pounds');
    assert.equal(ns.length, 1);
    assert.equal(ns[0].value, 48000);
    assert.equal(ns[0].unit, 'pounds');
    assert.equal(ns[0].label, 'load');
  });

  it('ignores bare digits (times and dates are not measurements)', () => {
    assert.deepEqual(extractNumbers('call at 6:30 about the 401 form'), []);
  });
});

describe('rules classifyPriority', () => {
  it('urgency and someone-waiting mean high', () => {
    assert.equal(classifyPriority('The pump repair is urgent'), 'high');
    assert.equal(classifyPriority('The hauler is waiting on us'), 'high');
    assert.equal(classifyPriority('The $4,000 payment is overdue'), 'high');
  });
  it('someday language means low, plain work means medium', () => {
    assert.equal(classifyPriority('Someday repaint the office, no rush'), 'low');
    assert.equal(classifyPriority('Call the vet about the follow-up'), 'medium');
  });
});

// ---------------------------------------------------------------------------
// Chain integration — opt-in only, keyless, offline
// ---------------------------------------------------------------------------

describe('rules provider in the chain', () => {
  it('is NOT in the default order and NOT auto-included', () => {
    assert.deepEqual(DEFAULT_ORDER, ['openai', 'gemini', 'anthropic']);
    assert.deepEqual(resolveChain({}), []);
    assert.deepEqual(resolveChain({ OPENAI_API_KEY: 'k' }), ['openai']);
  });

  it('enters the chain only when explicitly selected, with no keys at all', () => {
    assert.deepEqual(resolveChain({ ACTIONABLE_LLM_PROVIDER: 'rules' }), ['rules']);
    assert.deepEqual(
      resolveChain({ ACTIONABLE_LLM_PROVIDER: 'rules', GEMINI_API_KEY: 'g' }),
      ['rules', 'gemini'],
    );
  });

  it('answers through callExtraction without ever fetching', async () => {
    const out = await callExtraction({
      system: 'ignored by rules',
      text: 'Brain dump (spoken):\n"""\nCall the vet tomorrow.\n"""',
      env: { ACTIONABLE_LLM_PROVIDER: 'rules' },
      fetchImpl: () => { throw new Error('network must not be touched'); },
      context: { projects: PROJECTS, tags: [], people: [], nowIso: NOW, timezone: TZ },
    });
    assert.equal(out.provider, 'rules');
    const parsed = JSON.parse(out.text);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].due.iso, '2026-10-26T09:00:00-06:00');
  });

  it('extractEntry end-to-end: rules-selected env yields a normalized entry', async () => {
    const entry = await extractEntry({
      transcript: 'Remind me to call Rick at 6:30 tomorrow morning.',
      projects: PROJECTS, tags: [], people: ['Rick'],
      nowIso: NOW, timezone: TZ,
      env: { ACTIONABLE_LLM_PROVIDER: 'rules' },
      fetchImpl: () => { throw new Error('network must not be touched'); },
    });
    assert.equal(entry.extracted_by.provider, 'rules');
    assert.equal(entry.items.length, 1);
    assert.equal(entry.items[0].phone_action.kind, 'reminder');
    assert.equal(entry.items[0].phone_action.when_iso, '2026-10-26T12:30:00.000Z');
    assert.deepEqual(entry.people, ['Rick']);
  });
});
