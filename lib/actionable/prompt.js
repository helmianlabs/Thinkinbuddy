// lib/actionable/prompt.js
// ---------------------------------------------------------------------------
// The extraction prompt for Actionable (formerly "Site Diary").
//
// WHY THIS FILE EXISTS — the defect it replaces:
//   api/diary.js:100-113 asks Claude for ONE category per note, drawn from a
//   HARDCODED construction-site list: Safety | Progress | Subcontractor |
//   Material | Weather | Issue | Inspection | General. That is wrong twice over
//   for how this app is actually used:
//
//   1. WRONG DOMAIN. It is not a construction diary. It is a personal + business
//      brain dump.
//   2. WRONG SHAPE — the bigger error. A real dictated brain dump is NOT one
//      note about one thing. Verbatim sample (transcript
//      0b30441d-df1e-4eb5-830c-75d6f327c4e3.jsonl:2669) opens with a vet trip,
//      pivots to a business strategy for handing a whole software platform to a
//      customer, then ends assigning a Blender character-rigging pipeline with a
//      morning deadline. Three unrelated topics, two projects, one breath.
//      Forcing that into a single `category` throws away most of the dump.
//
//   So: one recording produces ONE entry containing MANY items, and the item —
//   not the entry — carries the project, the tags, the priority and the due date.
//
// CATEGORIES ARE DATA, NOT CODE. Nothing here hardcodes a category set. The
// caller passes the user's own editable project/tag lists (loaded from
// actionable_projects / actionable_tags) into buildSystemPrompt(). The constants
// below are only the FIRST-RUN seed for a brand-new account, and the user can
// rename or delete every one of them.
// ---------------------------------------------------------------------------

// First-run seed only. Written into actionable_projects on account creation,
// then owned by the user. Never re-applied over their edits.
export const SEED_PROJECTS = [
  { slug: 'personal',   label: 'Personal',   hint: 'home, family, pets, errands, health, vehicles, money' },
  { slug: 'business',   label: 'Business',   hint: 'strategy, partnerships, pricing, sales, customers, outreach' },
  { slug: 'consulting', label: 'Consulting', hint: 'client work billed as a service, site visits, training, audits' },
  { slug: 'product',    label: 'Product',    hint: 'software being built — features, bugs, releases, demos' },
  { slug: 'admin',      label: 'Admin',      hint: 'paperwork, filings, accounts, subscriptions, scheduling' },
];

export const ITEM_KINDS = [
  'task',      // something to DO
  'decision',  // something DECIDED — record it so it is not re-litigated
  'idea',      // a possibility, not yet committed
  'question',  // an open question needing an answer
  'blocker',   // something stopping progress
  'purchase',  // something to buy, with a price if one was said
  'note',      // context worth keeping that is none of the above
];

export const PRIORITIES = ['high', 'medium', 'low'];

// ---------------------------------------------------------------------------
// buildSystemPrompt
//
// @param {object}   opts
// @param {Array}    opts.projects  [{slug,label,hint}] — the USER'S list.
// @param {string[]} opts.tags      previously-used tags, for reuse over invention.
// @param {string}   opts.nowIso    caller's local time, ISO-8601 WITH offset.
// @param {string}   opts.timezone  IANA zone, e.g. 'America/Denver'.
// @param {boolean}  opts.hasImage  true when an photo accompanies the dump.
// @returns {string}
// ---------------------------------------------------------------------------
export function buildSystemPrompt({
  projects = SEED_PROJECTS,
  tags = [],
  people = [],
  nowIso = new Date().toISOString(),
  timezone = 'America/Denver',
  hasImage = false,
} = {}) {
  const projectList = projects.length
    ? projects.map(p => `  - "${p.slug}" (${p.label})${p.hint ? ` — ${p.hint}` : ''}`).join('\n')
    : '  (none defined yet)';

  const tagList = tags.length
    ? tags.slice(0, 60).map(t => `"${t}"`).join(', ')
    : '(none yet — this is a new account)';

  return `You process spoken brain dumps into structured, actionable records.

The person speaking is talking out loud into their phone, usually while doing
something else — driving, walking the dog, between jobs. They are not composing.
They ramble, they change subject mid-sentence, they mix their personal life with
several different businesses in one recording. That is expected and correct. Your
job is to catch ALL of it and sort it, not to tidy it into one topic.

RIGHT NOW IT IS ${nowIso} (timezone ${timezone}).

## THE ONE RULE THAT MATTERS MOST

ONE recording contains MANY items. Split the dump into a separate item for every
distinct thing said. A single recording routinely contains a household errand, a
business decision, and a list of work tasks for a completely different project.
Do not collapse them. Do not pick "the main topic" and discard the rest. If they
said it, it becomes an item.

Conversely, do not inflate: one thought said three different ways is ONE item.

THINGS THAT ARE ROUTINELY AND WRONGLY DROPPED — all of these ARE items:
- Something already DONE. "I took the dog to the vet", "I texted her", "I checked
  the invoice" → kind "note". It is a record of what happened, and it is often
  the only place that fact will ever be written down. Never discard a sentence
  just because it is in the past tense and needs no action.
- The small personal aside sitting between two business topics. The errand, the
  appointment, the family detail. It is not noise, it is half of why this
  recording exists.
- A standard or quality bar they set: "no clipping, no weirdness". Attach it to
  the item it constrains, or make it its own note.
- Something handed off or declined: "it's yours, I'm out of it" → a decision.

FINAL COVERAGE CHECK, before you emit anything: re-read the dump from the top,
sentence by sentence, and confirm every distinct topic produced at least one
item. If a sentence produced nothing, either add the item or put that sentence
in "unclear". Silently dropping it is the one failure this system cannot
tolerate — the user cannot know what was lost.

## THEIR PROJECTS

Tag each item with exactly one project slug from THEIR list:

${projectList}

If an item genuinely fits none of them, use your own short lowercase slug and set
"project_is_new": true. Do not force a bad fit just to use an existing slug — a
wrong tag is worse than a new one, because it hides the item in the wrong feed.
Use "project_is_new": false whenever you picked from the list above.

## THEIR EXISTING TAGS

Reuse these before inventing new ones, so the same subject does not end up under
three spellings: ${tagList}

## DICTATION IS GARBLED — REPAIR IT, BUT SHOW YOUR WORK

Speech-to-text mangles proper nouns, acronyms and numbers. Real examples from
this user: "local LL Mississippi" meant "local LLMs"; "sunview 3" was a site
name; a co-op's name and a person's name both came through misspelled.

- Use surrounding context to work out what was meant, and write the repaired
  form in the item text.
- Record every repair in "transcription_repairs" as {"heard","meant","why"}.
  This is not optional. They read this list to catch you being wrong.

  A REPAIR IS ONLY A GENUINE MISHEARING — the transcriber produced the WRONG
  WORDS and you are restoring the right ones. Nothing else belongs in this list:
    NOT capitalization      ("banner" → "Banner")
    NOT grammar or tidying  ("for the wash track first use system" → "...system")
    NOT filler removal      ("you know", "I mean")
    NOT a no-op             (if "heard" equals "meant", it is not a repair)
  Padding this list with style edits buries the one real mishearing in noise,
  which defeats the entire point of showing it.

  PERSON AND COMPANY NAMES ARE THE HIGHEST-VALUE REPAIRS and the easiest to
  miss, because a mangled name usually still reads as a plausible word. A name
  that appears as a country, a common noun, or a brand where a colleague's name
  belongs is almost certainly a mishearing — repair it AND list the repair, and
  make sure "people" carries the corrected spelling, not the misheard one.
${people.length ? `
  PEOPLE THIS USER ALREADY DEALS WITH — match a misheard name against this list
  before anything else, and prefer these spellings:
    ${people.slice(0, 40).join(', ')}
  A spoken name that is one or two sounds away from a name on this list IS that
  name. Repair it to the spelling shown here and record the repair.
` : ''}
- If you CANNOT work out what a garbled span meant, keep it verbatim and add it
  to "unclear" — never invent a plausible-sounding fact to cover a gap. A wrong
  guess presented as fact is the worst possible output of this system.

## WRITING THE ITEMS

- "text" for a task is a short imperative starting with a verb: "Call the vet
  about Banner's follow-up." Not "Banner needs a follow-up call."
- Keep THEIR words and their bluntness. Do not translate plain speech into
  corporate phrasing. If they said the throughput is terrible, the item says the
  throughput is terrible.
- Profanity is filtered upstream and may appear as asterisks. Leave it alone;
  never reconstruct it.
- "detail" carries the surrounding context, conditions and reasoning — the part
  that makes the item make sense in three weeks. Empty string if the text says
  it all.

## DATES AND TIMES

- Resolve relative language against the timestamp above: "Friday", "tomorrow",
  "end of month", "when I wake up" (= roughly 7:00 AM the next calendar day).
- "due.raw" is what they actually said. "due.iso" is your resolution, or null.
- NEVER invent a due date. Most items have none. If no time pressure was
  expressed, "due" is null. An invented deadline turns into a phone alarm at 6 AM
  for something that was never urgent.

## PHONE ACTIONS

Each item may request ONE device action, and only when the dump actually implies
it:
- "reminder"       — a nudge at a moment. Needs "when_iso".
- "calendar_event" — a real appointment/meeting with other people or a place.
                     Needs "when_iso" and "duration_min".
- "none"           — the default, and correct for most items.
Only set a phone action when a time is known or clearly implied. No time, no
action.

## PRIORITY

"high" only when they signalled urgency, a hard deadline, money at risk, or
somebody waiting on them. Default "medium". Background thinking is "low". If
everything is high, the field is useless.

## NUMBERS

Pull every quantity, price, count or measurement into "numbers" with a label and
unit. This is what decides whether this entry ALSO belongs in a spreadsheet
rather than only a document, so be thorough. A price range said as "60 to 100
bucks" is TWO entries, min and max, sharing a label.

## PEOPLE

List every person named, exactly once, as spoken.
${hasImage ? `
## THE ATTACHED PHOTO

A photo was attached to this dump.
- Read any text visible in it (whiteboard, sign, label, part number, form,
  handwriting) into "image_text", verbatim, preserving line breaks.
- If the image has no meaningful text, "image_text" is null and
  "image_has_text" is false. A photo of a truck part is a photo, not a document
  — do not narrate the picture into that field.
- "image_description" is one short sentence describing the photo either way, so
  it is findable later by search.
- If the photo contradicts the audio, trust the photo and note it in "unclear".
` : ''}
## OUTPUT

Return ONLY a JSON object. No prose, no markdown fence, no explanation.

FILL THE KEYS IN THE ORDER SHOWN. "topics" comes first and is not decoration —
it is the coverage check from above, written down. List every distinct thing
said, in the order said, as a short phrase, BEFORE you write any items. Walk the
dump end to end: an errand, a decision, an aside about a person, a standard they
set, a tool they named, a deadline — each is its own topic. Then write the items,
and every topic must be answered by at least one item or appear in "unclear".
Typical real dumps yield 8-14 topics; if you have fewer than 8 you have almost
certainly merged two things that were said separately, so go back through it.

{
  "topics": ["every distinct thing said, in the order said, before you write any items"],
  "title": "5-8 word title for the whole dump, specific enough to recognise later",
  "summary": "one sentence covering everything in the dump, not just the first topic",
  "items": [
    {
      "kind": "one of: ${ITEM_KINDS.join(' | ')}",
      "text": "the item, imperative for tasks",
      "detail": "context, or empty string",
      "project": "slug",
      "project_is_new": false,
      "tags": ["lowercase-kebab"],
      "priority": "one of: ${PRIORITIES.join(' | ')}",
      "due": { "raw": "", "iso": "" },
      "phone_action": { "kind": "none", "title": "", "when_iso": "", "duration_min": 0 }
    }
  ],
  "people": ["Name"],
  "numbers": [{ "label": "what it measures", "value": 0, "unit": "USD|GB|miles|count|...", "context": "as spoken" }],
  "open_questions": ["questions they raised but did not answer"],
  "transcription_repairs": [{ "heard": "...", "meant": "...", "why": "..." }],
  "unclear": ["spans you could not resolve — verbatim"],
  "image_has_text": false,
  "image_text": "",
  "image_description": ""
}

"due" when it exists is { "raw": "what they said", "iso": "2026-08-01T09:00:00-06:00" }.
When there is NO due date, "due" is { "raw": "", "iso": "" } — an empty string, never
a made-up date. Same for "phone_action": kind "none" with empty strings.${hasImage ? '' : `
There is no photo on this dump, so leave "image_text" and "image_description"
as empty strings and "image_has_text" false.`}

USE "" — NOT null — FOR EVERY ABSENT STRING. Every key above must be present on
every object, and every array must be present, using [] when empty. Never omit a
key and never emit null.`;
}

// Budget. The old prompt ran at max_tokens 512 (api/diary.js:124), which
// truncates any multi-item dump — the sample dumps produce 8-14 items and would
// be cut off mid-array, yielding invalid JSON. Sized for the longest observed
// real dump (2,509 chars in) with headroom.
export const EXTRACTION_MAX_TOKENS = 4096;

// The model is no longer a constant here. It belongs to whichever vendor is
// answering, and lives in lib/actionable/providers.js (MODELS), selectable by
// env. EXTRACTION_MODEL is kept only so an older import cannot crash at load.
export const EXTRACTION_MODEL = 'see lib/actionable/providers.js MODELS';

// ---------------------------------------------------------------------------
// EXTRACTION_JSON_SCHEMA — the shape, enforced by the vendor rather than hoped
// for in prose.
//
// Written to OpenAI's strict rules, which are the stricter of the two:
//   * every key of every object appears in that object's `required`
//   * `additionalProperties: false` on every object
//   * NO NULLABLE FIELDS ANYWHERE — absent is "" (or 0 for duration_min).
//
// That last rule is what makes ONE schema work on both vendors: OpenAI spells
// nullable as a ["string","null"] union and Gemini's subset historically wants
// `nullable: true`, so the schema simply never needs it. normalizeEntry() in
// extract.js already treats "" exactly as it treats null, so nothing
// downstream changes. providers.js:toGeminiSchema() handles the rest of the
// dialect gap (uppercase types, dropping additionalProperties).
// ---------------------------------------------------------------------------
const strObj = (keys) => ({
  type: 'object',
  properties: Object.fromEntries(keys.map(k => [k, { type: 'string' }])),
  required: keys,
  additionalProperties: false,
});

export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    // FIRST ON PURPOSE. A model fills a strict schema in key order, so making it
    // enumerate the dump's distinct topics before it may write a single item
    // turns the prompt's "final coverage check" from an instruction it can skip
    // into a field it must fill. Measured on the 1,815-char reference dump,
    // same model and same prompt otherwise:
    //   gpt-4.1-mini  7 items / 4 projects  →  9 items / 3 projects
    //   gpt-4.1-nano  5 items / 3 projects  →  8 items / 4 projects
    // The items it gains are the ones the dump buries mid-sentence: the named
    // partners, the NDA condition, and the "no clipping, no weirdness" standard.
    topics: { type: 'array', items: { type: 'string' } },
    title: { type: 'string' },
    summary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ITEM_KINDS },
          text: { type: 'string' },
          detail: { type: 'string' },
          project: { type: 'string' },
          project_is_new: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
          priority: { type: 'string', enum: PRIORITIES },
          // Empty strings mean "no due date" — never a guessed one.
          due: strObj(['raw', 'iso']),
          phone_action: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['reminder', 'calendar_event', 'none'] },
              title: { type: 'string' },
              when_iso: { type: 'string' },
              duration_min: { type: 'integer' },
            },
            required: ['kind', 'title', 'when_iso', 'duration_min'],
            additionalProperties: false,
          },
        },
        required: ['kind', 'text', 'detail', 'project', 'project_is_new', 'tags',
          'priority', 'due', 'phone_action'],
        additionalProperties: false,
      },
    },
    people: { type: 'array', items: { type: 'string' } },
    numbers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'number' },
          unit: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['label', 'value', 'unit', 'context'],
        additionalProperties: false,
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
    transcription_repairs: {
      type: 'array',
      items: strObj(['heard', 'meant', 'why']),
    },
    unclear: { type: 'array', items: { type: 'string' } },
    // Always present so one schema serves both the photo and no-photo calls.
    image_has_text: { type: 'boolean' },
    image_text: { type: 'string' },
    image_description: { type: 'string' },
  },
  required: ['topics', 'title', 'summary', 'items', 'people', 'numbers',
    'open_questions', 'transcription_repairs', 'unclear', 'image_has_text',
    'image_text', 'image_description'],
  additionalProperties: false,
};
