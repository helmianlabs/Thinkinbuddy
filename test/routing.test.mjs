// test/routing.test.mjs — multi-segment API routing (the store-test
// preview 404 fix). Live evidence that forced this (2026-10-23,
// thinkbuddy preview dpl_Eb1TqDEYaCnt4qr7KYb51V1Y87Rr):
//   GET /api/profile        -> 401 handler JSON   (router reached)
//   GET /api/auth           -> 404 handler JSON   (router reached)
//   GET /api/auth/login     -> 404 PLATFORM text  ("The page could not
//   GET /api/profile/pin    -> 404 PLATFORM text   be found / NOT_FOUND")
//   GET /api/relay/devices  -> 404 PLATFORM text
// In this Vite-framework build Vercel emits the api/[...path].js
// catch-all's route as a ONE-segment pattern, so every two-segment
// store route died before any function ran. The fix is thin physical
// route files (api/auth/*.js, api/profile/pin*.js, api/relay/**) that
// re-export the owning handler — physical files route exactly (the
// pre-existing api/conversation-webhook.js proves it: it answers 405,
// not the platform 404) — plus a 'relay' alias in the router, whose
// table previously knew the pairing handler only as 'relay-pair'
// while every client calls /api/relay/*.
//
// These tests pin, for EVERY multi-segment path the clients call:
//   1. a physical shim file exists and re-exports the right handler
//      (identity — the exact production default export);
//   2. dispatch through the shim AND through the router reaches the
//      right handler + sub-route. Probe shapes are chosen to
//      short-circuit BEFORE any database access (wrong method -> the
//      handler's own 405; no session token -> requireTenant's 401),
//      so no fake db is needed and nothing here can pass by accident:
//      a wrong handler answers its own different 404 shape.
//   3. statically: every multi-segment /api URL literal in
//      public/onboarding.js + public/connect.js has a shim file.
// /api/relay/pair/redeem is called by the Helmian desktop spoke, not
// the web client, so it is pinned explicitly in the tables below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import router from '../api/[...path].js';
import authHandler from '../server/handlers/auth.js';
import profileHandler from '../server/handlers/profile.js';
import relayPairHandler from '../server/handlers/relay-pair.js';

import shimAuthSignup from '../api/auth/signup.js';
import shimAuthLogin from '../api/auth/login.js';
import shimAuthDeleteAccount from '../api/auth/delete-account.js';
import shimProfilePin from '../api/profile/pin.js';
import shimProfilePinVerify from '../api/profile/pin/verify.js';
import shimRelayPairCreate from '../api/relay/pair/create.js';
import shimRelayPairRedeem from '../api/relay/pair/redeem.js';
import shimRelayPairRevoke from '../api/relay/pair/revoke.js';
import shimRelayDevices from '../api/relay/devices.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Hosted mode on (the preview sets SESSION_SECRET): handlers engage
// their tenant paths instead of the compat 503.
process.env.SESSION_SECRET = 'routing-test-secret';

function mockRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    writeHead(code) { this.statusCode = code; return this; },
    end(payload) { if (payload) this.body = payload; return this; },
  };
}

function reqFor(path, method) {
  return { url: path, method, headers: {}, query: {}, body: {} };
}

// The complete multi-segment store surface. `probe` picks a request
// shape that proves handler + sub-route with no db access (see header).
const SURFACE = [
  { path: '/api/auth/signup', shim: shimAuthSignup, handler: authHandler, probe: { method: 'GET', status: 405, error: 'method_not_allowed' } },
  { path: '/api/auth/login', shim: shimAuthLogin, handler: authHandler, probe: { method: 'GET', status: 405, error: 'method_not_allowed' } },
  { path: '/api/auth/delete-account', shim: shimAuthDeleteAccount, handler: authHandler, probe: { method: 'GET', status: 405, error: 'method_not_allowed' } },
  { path: '/api/profile/pin', shim: shimProfilePin, handler: profileHandler, probe: { method: 'POST', status: 401, error: 'Unauthorized' } },
  { path: '/api/profile/pin/verify', shim: shimProfilePinVerify, handler: profileHandler, probe: { method: 'POST', status: 401, error: 'Unauthorized' } },
  { path: '/api/relay/pair/create', shim: shimRelayPairCreate, handler: relayPairHandler, probe: { method: 'POST', status: 401, error: 'Unauthorized' } },
  { path: '/api/relay/pair/redeem', shim: shimRelayPairRedeem, handler: relayPairHandler, probe: { method: 'GET', status: 405, error: 'method_not_allowed' } },
  { path: '/api/relay/pair/revoke', shim: shimRelayPairRevoke, handler: relayPairHandler, probe: { method: 'POST', status: 401, error: 'Unauthorized' } },
  { path: '/api/relay/devices', shim: shimRelayDevices, handler: relayPairHandler, probe: { method: 'GET', status: 401, error: 'Unauthorized' } },
];

test('every shim re-exports its owning handler (identity)', () => {
  for (const { path, shim, handler } of SURFACE) {
    assert.equal(shim, handler, `${path}: shim must be the handler's default export`);
  }
});

test('dispatch through each shim reaches the right handler + sub-route', async () => {
  for (const { path, shim, probe } of SURFACE) {
    const res = mockRes();
    await shim(reqFor(path, probe.method), res);
    assert.equal(res.statusCode, probe.status, `${path} via shim`);
    assert.equal(res.body?.error, probe.error, `${path} via shim`);
  }
});

test('dispatch through the router reaches the same handler + sub-route', async () => {
  for (const { path, probe } of SURFACE) {
    const res = mockRes();
    await router(reqFor(path, probe.method), res);
    assert.equal(res.statusCode, probe.status, `${path} via router`);
    assert.equal(res.body?.error, probe.error, `${path} via router`);
  }
});

test('one-segment routes are unchanged through the router', async () => {
  // A live legacy route still dispatches (401 = handler, not platform).
  const prof = mockRes();
  await router(reqFor('/api/profile', 'GET'), prof);
  assert.equal(prof.statusCode, 401);
  // An unknown name still gets the ROUTER's own JSON 404 shape.
  const nope = mockRes();
  await router(reqFor('/api/nonexistent', 'GET'), nope);
  assert.equal(nope.statusCode, 404);
  assert.equal(JSON.parse(nope.body).error, 'Not found');
});

test('every multi-segment /api URL the web clients call has a physical route file', () => {
  const literals = new Set();
  for (const clientFile of ['public/onboarding.js', 'public/connect.js']) {
    const src = readFileSync(join(ROOT, clientFile), 'utf8');
    for (const m of src.matchAll(/'(\/api\/[a-z0-9\-/]+)'/g)) literals.add(m[1]);
  }
  const multi = [...literals].filter((p) => p.split('/').filter(Boolean).length >= 3);
  assert.ok(multi.length >= 7, `expected the store surface in client literals, got: ${multi.join(', ')}`);
  for (const p of multi) {
    const file = join(ROOT, 'api', `${p.replace(/^\/api\//, '')}.js`);
    assert.ok(existsSync(file), `${p} has no physical route file at ${file}`);
    // …and the pinned surface table covers it (no silent drift).
    assert.ok(SURFACE.some((s) => s.path === p), `${p} is called by a client but missing from the routing surface table`);
  }
  // The spoke-called redeem route is pinned even though no web client
  // literal names it.
  assert.ok(existsSync(join(ROOT, 'api', 'relay', 'pair', 'redeem.js')));
});
