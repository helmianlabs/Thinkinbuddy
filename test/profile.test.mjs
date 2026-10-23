// test/profile.test.mjs — accounts bite: tenant profiles, the parent
// PIN rule, and the profile -> safety wiring decision. Fake db, no live
// database. The profileSafety tests pin the EXACT helper the paid
// handlers (chat/speak/image/video) call in hosted mode, so the
// production path is what is verified here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGE_BANDS, getProfile, upsertProfile, setParentPin, verifyParentPin, profileSafety,
} from '../lib/profile.js';
import { createAccount } from '../lib/accounts.js';
import { signSession } from '../lib/tenant.js';
import { handleProfile } from '../server/handlers/profile.js';
import { FakeDb } from './fake-db.mjs';

const SECRET = 'profile-test-secret';
process.env.SESSION_SECRET = SECRET;

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

function authedReq(tenantId, { method = 'GET', url = 'http://local/api/profile', body = {} } = {}) {
  return {
    method,
    url,
    headers: { authorization: `Bearer ${signSession(tenantId, SECRET)}` },
    body,
  };
}

async function accountWithProfile(db, fields = {}) {
  const { tenantId } = await createAccount(db, {
    email: `u${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: 'a long passphrase',
  });
  if (Object.keys(fields).length) await upsertProfile(db, tenantId, fields);
  return tenantId;
}

// ─── getProfile / upsertProfile ───────────────────────────────────────────

test('getProfile returns null for an unknown tenant', async () => {
  const db = new FakeDb();
  assert.equal(await getProfile(db, '00000000-0000-4000-8000-000000000099'), null);
});

test('upsertProfile creates, then updates, whitelisted fields', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db);
  const created = await upsertProfile(db, tenantId, { display_name: 'Sam', age_band: '9-12', about_me: 'Loves frogs' });
  assert.equal(created.display_name, 'Sam');
  assert.equal(created.age_band, '9-12');
  const updated = await upsertProfile(db, tenantId, { display_name: 'Samuel' });
  assert.equal(updated.display_name, 'Samuel');
  assert.equal(updated.age_band, '9-12'); // untouched fields survive
});

test('upsertProfile IGNORES credential fields — parent_pin_hash/password cannot be written through it', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db);
  const row = await upsertProfile(db, tenantId, {
    display_name: 'Sam',
    parent_pin_hash: 'attacker-controlled',
    password_hash: 'attacker-controlled',
    tenant_id: 'someone-else',
  });
  assert.equal(row.display_name, 'Sam');
  assert.equal(row.parent_pin_hash, null);
  assert.equal(row.tenant_id, tenantId);
});

test('upsertProfile validates age_band against AGE_BANDS', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db);
  for (const band of AGE_BANDS) {
    const row = await upsertProfile(db, tenantId, { age_band: band });
    assert.equal(row.age_band, band);
  }
  await assert.rejects(
    upsertProfile(db, tenantId, { age_band: 'toddler' }),
    (e) => e.code === 'invalid_age_band',
  );
});

// ─── Parent PIN ───────────────────────────────────────────────────────────

test('setParentPin/verifyParentPin: correct PIN passes, wrong fails, unset fails closed', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db);
  assert.equal(await verifyParentPin(db, tenantId, '2468'), false); // no PIN set yet
  await setParentPin(db, tenantId, '2468');
  assert.equal(await verifyParentPin(db, tenantId, '2468'), true);
  assert.equal(await verifyParentPin(db, tenantId, '0000'), false);
  const stored = await getProfile(db, tenantId);
  assert.ok(stored.parent_pin_hash);
  assert.ok(!stored.parent_pin_hash.includes('2468')); // hash, never the PIN
});

test('setParentPin rejects a too-short PIN', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db);
  await assert.rejects(setParentPin(db, tenantId, '12'), (e) => e.code === 'invalid_pin');
});

// ─── profileSafety — the wiring decision the handlers call ────────────────

test('profileSafety: a minor profile yields failClosed + kidCore (the production wiring path)', () => {
  for (const band of ['child', '6-8', '9-12']) {
    assert.deepEqual(
      profileSafety({ safety_mode: false, age_band: band }),
      { failClosed: true, kidCore: true },
      `band ${band} must fail closed`,
    );
  }
});

test('profileSafety: adult without safety mode is neutral; safety mode on is fail-closed; null profile is neutral', () => {
  assert.deepEqual(profileSafety({ safety_mode: false, age_band: 'adult' }), { failClosed: false, kidCore: false });
  assert.deepEqual(profileSafety({ safety_mode: false, age_band: '13-17' }), { failClosed: false, kidCore: false });
  assert.deepEqual(profileSafety({ safety_mode: true, age_band: 'adult' }), { failClosed: true, kidCore: true });
  assert.deepEqual(profileSafety(null), { failClosed: false, kidCore: false });
});

// ─── /api/profile handler ─────────────────────────────────────────────────

test('GET /api/profile returns the whitelisted profile + plan, never the PIN hash', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db, { display_name: 'Sam', age_band: '6-8', safety_mode: true });
  await setParentPin(db, tenantId, '2468');
  const res = fakeRes();
  await handleProfile(authedReq(tenantId), res, db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.display_name, 'Sam');
  assert.equal(res.body.age_band, '6-8');
  assert.equal(res.body.safety_mode, true);
  assert.equal(res.body.pin_set, true);
  assert.equal(res.body.plan, 'free');
  assert.ok(!('parent_pin_hash' in res.body));
  const stored = await getProfile(db, tenantId);
  assert.ok(!JSON.stringify(res.body).includes(stored.parent_pin_hash));
});

test('PUT /api/profile writes whitelisted fields only (parent_pin_hash in the body is ignored)', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db);
  const res = fakeRes();
  await handleProfile(authedReq(tenantId, {
    method: 'PUT',
    body: { display_name: 'Jo', parent_pin_hash: 'attacker-controlled', password: 'x' },
  }), res, db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.display_name, 'Jo');
  assert.equal(res.body.pin_set, false);
  assert.equal((await getProfile(db, tenantId)).parent_pin_hash, null);
});

test("Troy's rule: safety OFF with a PIN set is refused without the PIN, refused with a wrong PIN, allowed with the right one", async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db, { safety_mode: true });
  await setParentPin(db, tenantId, '2468');

  const noPin = fakeRes();
  await handleProfile(authedReq(tenantId, { method: 'PUT', body: { safety_mode: false } }), noPin, db);
  assert.equal(noPin.statusCode, 403);
  assert.deepEqual(noPin.body, { error: 'parent_pin_required' });
  assert.equal((await getProfile(db, tenantId)).safety_mode, true); // unchanged

  const wrongPin = fakeRes();
  await handleProfile(authedReq(tenantId, { method: 'PUT', body: { safety_mode: false, pin: '0000' } }), wrongPin, db);
  assert.equal(wrongPin.statusCode, 403);
  assert.deepEqual(wrongPin.body, { error: 'invalid_parent_pin' });
  assert.equal((await getProfile(db, tenantId)).safety_mode, true);

  const rightPin = fakeRes();
  await handleProfile(authedReq(tenantId, { method: 'PUT', body: { safety_mode: false, pin: '2468' } }), rightPin, db);
  assert.equal(rightPin.statusCode, 200);
  assert.equal(rightPin.body.safety_mode, false);
  assert.equal((await getProfile(db, tenantId)).safety_mode, false);
});

test('safety OFF with NO PIN set is allowed but the response warns pinSet:false', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db, { safety_mode: true });
  const res = fakeRes();
  await handleProfile(authedReq(tenantId, { method: 'PUT', body: { safety_mode: false } }), res, db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.safety_mode, false);
  assert.equal(res.body.pinSet, false);
  assert.equal(res.body.warning, 'no_parent_pin_set');
});

test('POST /api/profile/pin sets the PIN; /pin/verify checks it', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db);
  const set = fakeRes();
  await handleProfile(authedReq(tenantId, {
    method: 'POST', url: 'http://local/api/profile/pin', body: { pin: '1357' },
  }), set, db);
  assert.equal(set.statusCode, 200);
  assert.deepEqual(set.body, { ok: true, pinSet: true });

  const good = fakeRes();
  await handleProfile(authedReq(tenantId, {
    method: 'POST', url: 'http://local/api/profile/pin/verify', body: { pin: '1357' },
  }), good, db);
  assert.deepEqual(good.body, { ok: true });

  const bad = fakeRes();
  await handleProfile(authedReq(tenantId, {
    method: 'POST', url: 'http://local/api/profile/pin/verify', body: { pin: '9999' },
  }), bad, db);
  assert.deepEqual(bad.body, { ok: false });
});

test('profile handler: no session token -> 401; compat mode -> 503', async () => {
  const db = new FakeDb();
  const tenantId = await accountWithProfile(db);
  const anon = fakeRes();
  // requireTenant writes via status().json() or writeHead/end — give the fake both.
  anon.writeHead = function (c) { this.statusCode = c; return this; };
  anon.end = function (s) { this.body = JSON.parse(s); return this; };
  await handleProfile({ method: 'GET', url: 'http://local/api/profile', headers: {}, body: {} }, anon, db);
  assert.equal(anon.statusCode, 401);

  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const compat = fakeRes();
    await handleProfile(authedReq(tenantId), compat, db);
    assert.equal(compat.statusCode, 503);
    assert.deepEqual(compat.body, { error: 'accounts_not_configured' });
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});
