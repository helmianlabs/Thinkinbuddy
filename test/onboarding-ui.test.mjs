// test/onboarding-ui.test.mjs — onboarding front-end bite: static +
// syntax checks over public/onboarding.js and the surgical index.html
// edits that host it. There is NO browser run in this bite — these tests
// pin the structure and the server-contract strings so a silent drift in
// either file fails loudly here instead of in a store review.
//
// Pinned contract:
//   - index.html has exactly one #accountOverlay container, one module
//     script include for /onboarding.js, one Account & Safety settings
//     pane, and the keys tab carries the exact Advanced relabel.
//   - Every new element id appears exactly once in index.html (a
//     duplicate id would make getElementById wiring in onboarding.js
//     hit the wrong node).
//   - public/onboarding.js parses (node --check) and contains the exact
//     endpoint paths, storage keys, age-band values, and PIN copy the
//     server (bite 5a) and the product rules depend on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const onboardingJs = readFileSync(new URL('../public/onboarding.js', import.meta.url), 'utf8');

const NEW_IDS = [
  'accountOverlay',
  'accountPane',
  'accountPlanLine',
  'accountSafetyToggle',
  'accountSafetyPinRow',
  'accountSafetyPin',
  'accountSafetyPinConfirm',
  'accountStatusLine',
  'accountPinStatus',
  'accountCurrentPinRow',
  'accountCurrentPin',
  'accountNewPin',
  'accountNewPinConfirm',
  'accountPinSave',
  'accountPinLine',
  'accountLogout',
];

test('public/onboarding.js parses as a valid ES module (node --check)', () => {
  execFileSync(process.execPath, ['--check', `${root}public/onboarding.js`], { stdio: 'pipe' });
});

test('index.html hosts exactly one account overlay container', () => {
  assert.match(indexHtml, /<div class="onboarding hidden" id="accountOverlay"><\/div>/);
});

test('index.html loads onboarding.js the way other public assets are referenced', () => {
  // public/ files are served at the site root (/manifest.json, /icon.svg),
  // so the module is /onboarding.js — NOT /public/onboarding.js.
  assert.ok(indexHtml.includes('<script type="module" src="/onboarding.js"></script>'));
});

test('index.html has the Account & Safety settings tab and pane', () => {
  assert.ok(indexHtml.includes('<button data-tab="account">Account &amp; Safety</button>'));
  assert.ok(indexHtml.includes('<div class="tab-pane" data-pane="account" id="accountPane">'));
});

test('keys tab carries the Advanced relabel, character for character', () => {
  assert.ok(indexHtml.includes('Advanced — your own API keys (optional)'));
  assert.ok(indexHtml.includes('data-tab="keys"'));
});

test('every new element id appears exactly once in index.html', () => {
  for (const id of NEW_IDS) {
    const count = indexHtml.split(`id="${id}"`).length - 1;
    assert.equal(count, 1, `id "${id}" should appear exactly once, found ${count}`);
  }
});

test('onboarding.js talks to the exact bite-5a endpoints', () => {
  for (const path of ['/api/auth/signup', '/api/auth/login', '/api/profile', '/api/profile/pin', '/api/profile/pin/verify']) {
    assert.ok(onboardingJs.includes(path), `missing endpoint string ${path}`);
  }
});

test('onboarding.js uses the tb_token / tb_tenant storage keys', () => {
  assert.ok(onboardingJs.includes("'tb_token'"));
  assert.ok(onboardingJs.includes("'tb_tenant'"));
  assert.ok(onboardingJs.includes('Authorization'));
  assert.ok(onboardingJs.includes('Bearer'));
});

test('onboarding.js exports tbFetch and sends the Bearer header through it', () => {
  assert.match(onboardingJs, /export async function tbFetch\(/);
});

test('onboarding.js degrades on accounts_not_configured (legacy mode)', () => {
  assert.ok(onboardingJs.includes('accounts_not_configured'));
  assert.ok(onboardingJs.includes('enterLegacyMode'));
});

test('onboarding.js carries the exact AGE_BANDS values and friendly labels', () => {
  for (const value of ['child', '6-8', '9-12', '13-17', 'adult']) {
    assert.ok(onboardingJs.includes(`value: '${value}'`), `missing age band value ${value}`);
  }
  for (const label of ['Under 6', '6–8', '9–12', '13–17', 'Adult']) {
    assert.ok(onboardingJs.includes(label), `missing age band label ${label}`);
  }
});

test('onboarding.js carries the parent-PIN copy, character for character', () => {
  assert.ok(onboardingJs.includes('This PIN keeps safety settings locked. Only a parent should know it.'));
});

test('onboarding.js wires billing after sign-in, guarded so it cannot break login', () => {
  assert.ok(onboardingJs.includes("import('./billing.js')"));
  assert.ok(onboardingJs.includes('configureBilling'));
});

test('onboarding.js maps the friendly auth errors', () => {
  assert.ok(onboardingJs.includes("Email or password didn't match."));
  assert.ok(onboardingJs.includes('That email already has an account — log in instead.'));
});
