// test/accounts.test.mjs — accounts bite: email/password identity.
// Fake in-memory db (pg-style query) — no live database, same posture as
// test/usage.test.mjs. Covers lib/accounts.js and the /api/auth handler
// shapes, including the no-enumeration rule (unknown email and wrong
// password are indistinguishable in result AND response body).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword, verifyPassword, validateEmail, isValidPassword,
  createAccount, findTenantByEmail, authenticate, PASSWORD_MIN_LENGTH,
} from '../lib/accounts.js';
import { verifySession } from '../lib/tenant.js';
import { handleAuth } from '../server/handlers/auth.js';

const SECRET = 'accounts-test-secret';
process.env.SESSION_SECRET = SECRET;

import { FakeDb } from './fake-db.mjs';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

const signupReq = (email, password) => ({
  method: 'POST', url: 'http://local/api/auth/signup', headers: {}, body: { email, password },
});
const loginReq = (email, password) => ({
  method: 'POST', url: 'http://local/api/auth/login', headers: {}, body: { email, password },
});

// ─── Password hashing + policy ────────────────────────────────────────────

test('hashPassword/verifyPassword round-trip; wrong password and malformed stored fail', () => {
  const stored = hashPassword('correct horse battery');
  assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/);
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('wrong horse battery', stored), false);
  assert.equal(verifyPassword('correct horse battery', 'not-a-hash'), false);
  assert.equal(verifyPassword('correct horse battery', null), false);
  // Same password, different salt -> different stored value.
  assert.notEqual(hashPassword('correct horse battery'), stored);
});

test('validateEmail normalizes and rejects malformed addresses', () => {
  assert.equal(validateEmail('  Parent@Example.COM '), 'parent@example.com');
  assert.equal(validateEmail('no-at-sign.example.com'), null);
  assert.equal(validateEmail('a@b'), null);
  assert.equal(validateEmail(''), null);
  assert.equal(validateEmail(null), null);
});

test('password policy: minimum length is enforced', () => {
  assert.equal(PASSWORD_MIN_LENGTH, 10);
  assert.equal(isValidPassword('123456789'), false);
  assert.equal(isValidPassword('1234567890'), true);
  assert.equal(isValidPassword(123456789012), false);
});

// ─── createAccount / authenticate ─────────────────────────────────────────

test('createAccount writes tenant + empty profile + free entitlement', async () => {
  const db = new FakeDb();
  const { tenantId } = await createAccount(db, { email: 'Parent@Example.com', password: 'a long passphrase' });
  assert.ok(tenantId);
  const tenant = db.tenants.find((t) => t.id === tenantId);
  assert.equal(tenant.email, 'parent@example.com'); // normalized
  assert.equal(tenant.auth_provider, 'email');
  assert.equal(tenant.status, 'active');
  assert.notEqual(tenant.password_hash, 'a long passphrase'); // never stored raw
  assert.equal(verifyPassword('a long passphrase', tenant.password_hash), true);
  assert.ok(db.profiles.has(tenantId));
  assert.equal(db.profiles.get(tenantId).safety_mode, false);
  assert.equal(db.entitlements.get(tenantId).plan, 'free');
  assert.equal(db.entitlements.get(tenantId).status, 'active');
});

test('createAccount rejects invalid email and weak password with coded errors', async () => {
  const db = new FakeDb();
  await assert.rejects(
    createAccount(db, { email: 'nope', password: 'a long passphrase' }),
    (e) => e.code === 'invalid_email',
  );
  await assert.rejects(
    createAccount(db, { email: 'ok@example.com', password: 'short' }),
    (e) => e.code === 'weak_password',
  );
  assert.equal(db.tenants.length, 0);
});

test('createAccount duplicate email -> email_taken (case-insensitive)', async () => {
  const db = new FakeDb();
  await createAccount(db, { email: 'dup@example.com', password: 'a long passphrase' });
  await assert.rejects(
    createAccount(db, { email: 'DUP@example.com', password: 'another passphrase' }),
    (e) => e.code === 'email_taken',
  );
  assert.equal(db.tenants.length, 1);
});

test('findTenantByEmail finds by normalized email, null for unknown', async () => {
  const db = new FakeDb();
  const { tenantId } = await createAccount(db, { email: 'find@example.com', password: 'a long passphrase' });
  const row = await findTenantByEmail(db, ' FIND@example.com ');
  assert.equal(row.id, tenantId);
  assert.equal(await findTenantByEmail(db, 'ghost@example.com'), null);
});

test('authenticate: success returns the tenant; unknown email and wrong password are the same null', async () => {
  const db = new FakeDb();
  const { tenantId } = await createAccount(db, { email: 'login@example.com', password: 'a long passphrase' });
  assert.deepEqual(await authenticate(db, { email: 'login@example.com', password: 'a long passphrase' }), { tenantId });
  const wrong = await authenticate(db, { email: 'login@example.com', password: 'the wrong passphrase' });
  const unknown = await authenticate(db, { email: 'ghost@example.com', password: 'a long passphrase' });
  assert.equal(wrong, null);
  assert.equal(unknown, null);
  assert.deepEqual(wrong, unknown); // no enumeration signal in the return shape
});

// ─── /api/auth handler ────────────────────────────────────────────────────

test('POST /api/auth/signup -> 201 { token, tenantId } with a verifiable session token', async () => {
  const db = new FakeDb();
  const res = fakeRes();
  await handleAuth(signupReq('new@example.com', 'a long passphrase'), res, db);
  assert.equal(res.statusCode, 201);
  assert.ok(res.body.tenantId);
  assert.deepEqual(verifySession(res.body.token, SECRET), { tenantId: res.body.tenantId });
});

test('POST /api/auth/signup duplicate -> 409 email_taken; weak password -> 400', async () => {
  const db = new FakeDb();
  await handleAuth(signupReq('taken@example.com', 'a long passphrase'), fakeRes(), db);
  const dup = fakeRes();
  await handleAuth(signupReq('taken@example.com', 'a long passphrase'), dup, db);
  assert.equal(dup.statusCode, 409);
  assert.deepEqual(dup.body, { error: 'email_taken' });
  const weak = fakeRes();
  await handleAuth(signupReq('weak@example.com', 'short'), weak, db);
  assert.equal(weak.statusCode, 400);
  assert.deepEqual(weak.body, { error: 'weak_password' });
});

test('POST /api/auth/login -> 200 on success; identical 401 body for wrong password and unknown email', async () => {
  const db = new FakeDb();
  await handleAuth(signupReq('user@example.com', 'a long passphrase'), fakeRes(), db);
  const ok = fakeRes();
  await handleAuth(loginReq('user@example.com', 'a long passphrase'), ok, db);
  assert.equal(ok.statusCode, 200);
  assert.ok(verifySession(ok.body.token, SECRET));

  const wrong = fakeRes();
  await handleAuth(loginReq('user@example.com', 'the wrong passphrase'), wrong, db);
  const unknown = fakeRes();
  await handleAuth(loginReq('ghost@example.com', 'a long passphrase'), unknown, db);
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(wrong.body, { error: 'invalid_credentials' });
  assert.deepEqual(unknown.body, wrong.body); // indistinguishable
});

test('compat mode (no SESSION_SECRET) -> 503 accounts_not_configured', async () => {
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const res = fakeRes();
    await handleAuth(signupReq('x@example.com', 'a long passphrase'), res, new FakeDb());
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'accounts_not_configured' });
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});
