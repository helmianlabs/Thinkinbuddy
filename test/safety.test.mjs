// test/safety.test.mjs — child-safety bite coverage.
//
//   - lib/moderation.js: the failClosed option. Default behaviour is
//     the historical fail-open policy (pinned by tests so it can never
//     drift silently); failClosed:true refuses whenever screening
//     cannot happen. A flagged result blocks in BOTH modes.
//   - lib/personality.js: BASE_GUARDRAILS is in every prompt, appended
//     after the persona; KID_SAFETY_CORE joins it only when safety
//     mode is on or the age band is a minor band.
//   - lib/safety.js: the safetyDecision matrix, the minor-band rule,
//     request plumbing extraction, and the parent-PIN hash/verify.
//
// fetch is stubbed per test — no live calls anywhere in this file.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed } from '../lib/moderation.js';
import { buildSystemPrompt, BASE_GUARDRAILS, KID_SAFETY_CORE, BUDDY_VOICE } from '../lib/personality.js';
import {
  safetyDecision,
  safetyInputsFromRequest,
  isMinorAgeBand,
  hashPin,
  verifyPin,
} from '../lib/safety.js';

const realFetch = globalThis.fetch;
const realError = console.error;
const realWarn = console.warn;

function stubFetch(impl) {
  globalThis.fetch = impl;
}
const fetchApiError = async () => ({ ok: false, status: 500, text: async () => 'server error' });
const fetchNetworkError = async () => { throw new Error('network down'); };
const fetchMalformed = async () => ({ ok: true, json: async () => ({}) });
const fetchFlagged = async () => ({
  ok: true,
  json: async () => ({ results: [{ flagged: true, categories: { sexual: true, violence: false } }] }),
});
const fetchClean = async () => ({
  ok: true,
  json: async () => ({ results: [{ flagged: false, categories: {} }] }),
});

describe('moderation fail-open default (historical behaviour, unchanged)', () => {
  beforeEach(() => { console.error = () => {}; console.warn = () => {}; });
  afterEach(() => { globalThis.fetch = realFetch; console.error = realError; console.warn = realWarn; });

  it('allows on API error by default', async () => {
    stubFetch(fetchApiError);
    const r = await isAllowed('hello', 'sk-test');
    assert.deepEqual(r, { allowed: true, reason: null });
  });

  it('allows on network error by default', async () => {
    stubFetch(fetchNetworkError);
    const r = await isAllowed('hello', 'sk-test');
    assert.equal(r.allowed, true);
  });

  it('allows on a missing key by default — without calling fetch', async () => {
    let called = false;
    stubFetch(async () => { called = true; throw new Error('must not be called'); });
    const r = await isAllowed('hello', null);
    assert.equal(r.allowed, true);
    assert.equal(called, false);
  });

  it('allows a clean result', async () => {
    stubFetch(fetchClean);
    const r = await isAllowed('hello', 'sk-test');
    assert.deepEqual(r, { allowed: true, reason: null });
  });
});

describe('moderation failClosed:true (safety mode / minor band)', () => {
  beforeEach(() => { console.error = () => {}; console.warn = () => {}; });
  afterEach(() => { globalThis.fetch = realFetch; console.error = realError; console.warn = realWarn; });

  it('refuses on API error with reason moderation_unavailable', async () => {
    stubFetch(fetchApiError);
    const r = await isAllowed('hello', 'sk-test', { failClosed: true });
    assert.deepEqual(r, { allowed: false, reason: 'moderation_unavailable' });
  });

  it('refuses on network error / timeout', async () => {
    stubFetch(fetchNetworkError);
    const r = await isAllowed('hello', 'sk-test', { failClosed: true });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'moderation_unavailable');
  });

  it('refuses on a missing key', async () => {
    const r = await isAllowed('hello', null, { failClosed: true });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'moderation_unavailable');
  });

  it('refuses on a malformed response', async () => {
    stubFetch(fetchMalformed);
    const r = await isAllowed('hello', 'sk-test', { failClosed: true });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'moderation_unavailable');
  });

  it('still allows a clean result', async () => {
    stubFetch(fetchClean);
    const r = await isAllowed('hello', 'sk-test', { failClosed: true });
    assert.deepEqual(r, { allowed: true, reason: null });
  });
});

describe('moderation flagged result blocks in both modes', () => {
  beforeEach(() => { console.error = () => {}; console.warn = () => {}; });
  afterEach(() => { globalThis.fetch = realFetch; console.error = realError; console.warn = realWarn; });

  it('blocks flagged text by default', async () => {
    stubFetch(fetchFlagged);
    const r = await isAllowed('bad text', 'sk-test');
    assert.equal(r.allowed, false);
    assert.match(r.reason, /sexual/);
  });

  it('blocks flagged text with failClosed:true', async () => {
    stubFetch(fetchFlagged);
    const r = await isAllowed('bad text', 'sk-test', { failClosed: true });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /sexual/);
  });
});

describe('personality safety layers', () => {
  it('BASE_GUARDRAILS is exported and non-empty', () => {
    assert.equal(typeof BASE_GUARDRAILS, 'string');
    assert.ok(BASE_GUARDRAILS.length > 100);
    assert.match(BASE_GUARDRAILS, /minor/i);
  });

  it('default prompt contains BASE_GUARDRAILS, positioned after the persona', () => {
    const prompt = buildSystemPrompt({});
    assert.ok(prompt.includes(BASE_GUARDRAILS));
    assert.ok(
      prompt.indexOf(BASE_GUARDRAILS) > prompt.indexOf(BUDDY_VOICE.base),
      'guardrails must come after the persona so they win on conflict',
    );
  });

  it('default prompt (adult, no safety mode) has NO kid core', () => {
    assert.ok(!buildSystemPrompt({}).includes(KID_SAFETY_CORE));
    assert.ok(!buildSystemPrompt({ ageBand: 'adult' }).includes(KID_SAFETY_CORE));
  });

  it('safetyMode:true adds the kid core', () => {
    assert.ok(buildSystemPrompt({ safetyMode: true }).includes(KID_SAFETY_CORE));
  });

  it('a minor age band adds the kid core without safety mode', () => {
    assert.ok(buildSystemPrompt({ ageBand: '9-12' }).includes(KID_SAFETY_CORE));
    assert.ok(buildSystemPrompt({ ageBand: '6-8' }).includes(KID_SAFETY_CORE));
    assert.ok(buildSystemPrompt({ ageBand: 'child' }).includes(KID_SAFETY_CORE));
  });

  it('a 13+ band alone does NOT add the kid core (documented under-13 rule)', () => {
    assert.ok(!buildSystemPrompt({ ageBand: '13-17' }).includes(KID_SAFETY_CORE));
  });
});

describe('safetyDecision matrix', () => {
  it('nothing on, no band -> both false', () => {
    assert.deepEqual(safetyDecision({}), { failClosed: false, kidCore: false });
    assert.deepEqual(safetyDecision(), { failClosed: false, kidCore: false });
  });

  it('safety mode on -> both true', () => {
    assert.deepEqual(safetyDecision({ safetyMode: true }), { failClosed: true, kidCore: true });
  });

  it('minor age band -> both true even with safety mode off', () => {
    assert.deepEqual(safetyDecision({ safetyMode: false, ageBand: '9-12' }), { failClosed: true, kidCore: true });
    assert.deepEqual(safetyDecision({ ageBand: 'child' }), { failClosed: true, kidCore: true });
  });

  it('adult band, safety off -> both false', () => {
    assert.deepEqual(safetyDecision({ ageBand: 'adult' }), { failClosed: false, kidCore: false });
    assert.deepEqual(safetyDecision({ ageBand: '18+' }), { failClosed: false, kidCore: false });
  });
});

describe('isMinorAgeBand rule', () => {
  it('child bands and under-13 ranges are minor', () => {
    for (const band of ['child', '6-8', '9-12', '0-5', 'under-13', '7']) {
      assert.equal(isMinorAgeBand(band), true, band);
    }
  });

  it('13+ bands and non-strings are not minor under this rule', () => {
    for (const band of ['13-17', 'teen', 'adult', '18+', '', null, undefined, 9]) {
      assert.equal(isMinorAgeBand(band), false, String(band));
    }
  });
});

describe('safetyInputsFromRequest', () => {
  it('reads top-level body fields', () => {
    const req = { body: { safetyMode: true, ageBand: '9-12' }, query: {} };
    assert.deepEqual(safetyInputsFromRequest(req), { safetyMode: true, ageBand: '9-12' });
  });

  it('reads the chat userContext plumbing', () => {
    const req = { body: { userContext: { safetyMode: true, ageBand: 'child' } } };
    assert.deepEqual(safetyInputsFromRequest(req), { safetyMode: true, ageBand: 'child' });
  });

  it('defaults to false/null when nothing is present', () => {
    assert.deepEqual(safetyInputsFromRequest({ body: {} }), { safetyMode: false, ageBand: null });
    assert.deepEqual(safetyInputsFromRequest({}), { safetyMode: false, ageBand: null });
  });
});

describe('parent PIN (hashPin / verifyPin)', () => {
  it('round-trip: the right PIN verifies', () => {
    const stored = hashPin('2468');
    assert.equal(verifyPin('2468', stored), true);
  });

  it('stored value is salted scrypt in salt:hash form, never the PIN', () => {
    const stored = hashPin('2468');
    assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
    // Random salt: two hashes of the same PIN differ, both verify.
    const other = hashPin('2468');
    assert.notEqual(stored, other);
    assert.equal(verifyPin('2468', other), true);
  });

  it('the wrong PIN is rejected', () => {
    const stored = hashPin('2468');
    assert.equal(verifyPin('0000', stored), false);
    assert.equal(verifyPin('24680', stored), false);
    assert.equal(verifyPin('', stored), false);
  });

  it('malformed stored values are rejected, never throw', () => {
    for (const bad of ['', 'nope', ':', 'zz:yy', null, undefined, 42]) {
      assert.equal(verifyPin('2468', bad), false, String(bad));
    }
  });
});
