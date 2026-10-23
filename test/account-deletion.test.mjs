// test/account-deletion.test.mjs — store-prep bite: account deletion
// (Apple 5.1.1(v) / Play account-deletion requirement).
// Covers lib/accounts.js deleteAccount + findTenantById against the
// shared FakeDb, and the POST /api/auth/delete-account handler shape:
// session token AND current password both required; a wrong password
// deletes NOTHING; another tenant's rows are never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAccount, findTenantById, deleteAccount,
  ACCOUNT_CORE_TABLES, ACCOUNT_OPTIONAL_TABLES,
} from '../lib/accounts.js';
import { signSession } from '../lib/tenant.js';
import { handleAuth } from '../server/handlers/auth.js';

const SECRET = '<redacted>';
process.env.SESSION_SECRET = SECRET;

import { FakeDb, GENERIC_TENANT_TABLES } from './fake-db.mjs';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

const deleteReq = (token, password) => ({
  method: 'POST',
  url: 'http://local/api/auth/delete-account',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: { password },
});

/** Seed one tenant with rows across generic tables; returns counts. */
function seedRows(db, tenantId, perTable = 2) {
  for (const table of GENERIC_TENANT_TABLES) {
    for (let i = 0; i < perTable; i++) db.rows[table].push({ tenant_id: tenantId, n: i });
  }
}

function rowsFor(db, tenantId) {
  const out = {};
  for (const table of GENERIC_TENANT_TABLES) {
    out[table] = db.rows[table].filter((r) => r.tenant_id === tenantId).length;
  }
  return out;
}

async function twoTenants(db) {
  const a = await createAccount(db, { email: 'a@example.com', password: 'password-for-a' });
  const b = await createAccount(db, { email: 'b@example.com', password: 'password-for-b' });
  seedRows(db, a.tenantId);
  seedRows(db, b.tenantId);
  return { a: a.tenantId, b: b.tenantId };
}

// ─── lib: findTenantById ─────────────────────────────────────────────────

test('findTenantById returns the row for a real tenant, null otherwise', async () => {
  const db = new FakeDb();
  const { tenantId } = await createAccount(db, { email: 'find@example.com', password: 'find-me-password' });
  const row = await findTenantById(db, tenantId);
  assert.equal(row.id, tenantId);
  assert.equal(row.email, 'find@example.com');
  assert.ok(row.password_hash);
  assert.equal(await findTenantById(db, 'no-such-tenant'), null);
  assert.equal(await findTenantById(db, null), null);
});

// ─── lib: deleteAccount ──────────────────────────────────────────────────

test('deleteAccount erases every tenant-scoped row for that tenant — and only that tenant', async () => {
  const db = new FakeDb();
  const { a, b } = await twoTenants(db);

  const { tenantId, deletedRows } = await deleteAccount(db, a);
  assert.equal(tenantId, a);
  assert.equal(deletedRows.tenants, 1);
  assert.equal(deletedRows.profiles, 1);
  assert.equal(deletedRows.entitlements, 1);
  for (const table of GENERIC_TENANT_TABLES) assert.equal(deletedRows[table], 2, table);

  // Tenant A: nothing left anywhere.
  assert.equal(db.tenants.some((t) => t.id === a), false);
  assert.equal(db.profiles.has(a), false);
  assert.equal(db.entitlements.has(a), false);
  for (const [table, n] of Object.entries(rowsFor(db, a))) assert.equal(n, 0, table);

  // Tenant B: fully intact.
  assert.equal(db.tenants.some((t) => t.id === b), true);
  assert.equal(db.profiles.has(b), true);
  assert.equal(db.entitlements.has(b), true);
  for (const [table, n] of Object.entries(rowsFor(db, b))) assert.equal(n, 2, table);
});

test('deleteAccount covers exactly the core + optional table lists', () => {
  for (const t of ['profiles', 'usage_ledger', 'user_keys', 'entitlements',
    'relay_devices', 'relay_pairing_codes', 'tenant_credit_grants']) {
    assert.ok(ACCOUNT_CORE_TABLES.includes(t), t);
  }
  for (const t of ['memory_items', 'conversation_sessions', 'conversation_turns',
    'actionable_projects', 'actionable_settings', 'actionable_google_accounts',
    'actionable_connections', 'actionable_entries', 'actionable_items']) {
    assert.ok(ACCOUNT_OPTIONAL_TABLES.includes(t), t);
  }
});

test('deleteAccount tolerates a missing optional table (pg 42P01) and still completes', async () => {
  const db = new FakeDb();
  const { a } = await twoTenants(db);
  db.missingTables.add('memory_items');
  db.missingTables.add('actionable_items');
  const { deletedRows } = await deleteAccount(db, a);
  assert.equal(deletedRows.memory_items, 0);
  assert.equal(deletedRows.actionable_items, 0);
  assert.equal(deletedRows.tenants, 1);
  assert.equal(db.tenants.some((t) => t.id === a), false);
});

test('deleteAccount requires a tenantId', async () => {
  const db = new FakeDb();
  await assert.rejects(() => deleteAccount(db, null), (e) => e.code === 'tenant_required');
  await assert.rejects(() => deleteAccount(db, ''), (e) => e.code === 'tenant_required');
});

// ─── Handler: POST /api/auth/delete-account ─────────────────────────────

test('handler: correct password + session deletes the account, 200 { deleted: true }', async () => {
  const db = new FakeDb();
  const { a, b } = await twoTenants(db);
  const token = signSession(a, SECRET);
  const res = fakeRes();
  await handleAuth(deleteReq(token, 'password-for-a'), res, db);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { deleted: true });
  assert.equal(db.tenants.some((t) => t.id === a), false);
  assert.equal(db.profiles.has(a), false);
  for (const [table, n] of Object.entries(rowsFor(db, a))) assert.equal(n, 0, table);
  // B untouched.
  assert.equal(db.tenants.some((t) => t.id === b), true);
  for (const [table, n] of Object.entries(rowsFor(db, b))) assert.equal(n, 2, table);
});

test('handler: wrong password deletes NOTHING, 401 invalid_credentials', async () => {
  const db = new FakeDb();
  const { a } = await twoTenants(db);
  const token = signSession(a, SECRET);
  const res = fakeRes();
  await handleAuth(deleteReq(token, 'not-the-password'), res, db);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'invalid_credentials' });
  assert.equal(db.tenants.some((t) => t.id === a), true);
  assert.equal(db.profiles.has(a), true);
  assert.equal(db.entitlements.has(a), true);
  for (const [table, n] of Object.entries(rowsFor(db, a))) assert.equal(n, 2, table);
});

test('handler: missing password deletes NOTHING, 401', async () => {
  const db = new FakeDb();
  const { a } = await twoTenants(db);
  const token = signSession(a, SECRET);
  const res = fakeRes();
  await handleAuth(deleteReq(token, undefined), res, db);
  assert.equal(res.statusCode, 401);
  assert.equal(db.tenants.some((t) => t.id === a), true);
});

test('handler: no session token deletes NOTHING, 401', async () => {
  const db = new FakeDb();
  const { a } = await twoTenants(db);
  const res = fakeRes();
  await handleAuth(deleteReq(null, 'password-for-a'), res, db);
  assert.equal(res.statusCode, 401);
  assert.equal(db.tenants.some((t) => t.id === a), true);
  for (const [table, n] of Object.entries(rowsFor(db, a))) assert.equal(n, 2, table);
});

test("handler: one tenant's session cannot delete another tenant (token scopes the wipe)", async () => {
  const db = new FakeDb();
  const { a, b } = await twoTenants(db);
  // A's token + A's password: only A can go, even though B exists.
  const token = signSession(a, SECRET);
  const res = fakeRes();
  await handleAuth(deleteReq(token, 'password-for-a'), res, db);
  assert.equal(res.statusCode, 200);
  assert.equal(db.tenants.some((t) => t.id === b), true);
  // B's password under A's session: wrong for A -> 401, B safe.
  const db2 = new FakeDb();
  const t2 = await twoTenants(db2);
  const res2 = fakeRes();
  await handleAuth(deleteReq(signSession(t2.a, SECRET), 'password-for-b'), res2, db2);
  assert.equal(res2.statusCode, 401);
  assert.equal(db2.tenants.some((t) => t.id === t2.b), true);
  assert.equal(db2.tenants.some((t) => t.id === t2.a), true);
});

test('handler: compat mode (no SESSION_SECRET) answers 503 and deletes nothing', async () => {
  const db = new FakeDb();
  const { a } = await twoTenants(db);
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const res = fakeRes();
    await handleAuth(deleteReq('any-token', 'password-for-a'), res, db);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'accounts_not_configured' });
  } finally {
    process.env.SESSION_SECRET = saved;
  }
  assert.equal(db.tenants.some((t) => t.id === a), true);
});

// ─── UI wiring (static, same posture as onboarding-ui.test.mjs) ─────────

import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const onboardingSrc = readFileSync(new URL('../public/onboarding.js', import.meta.url), 'utf8');

test('index.html Account pane hosts the delete block with the plain-language warnings', () => {
  for (const id of ['accountDeleteOpen', 'accountDeleteConfirm', 'accountDeletePassword',
    'accountDeleteType', 'accountDeleteConfirmBtn', 'accountDeleteCancel', 'accountDeleteLine']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
  assert.ok(html.includes('Type DELETE to confirm'));
  assert.ok(html.includes('permanently erases'));
  // The subscription truth, in the UI, before anyone taps delete:
  assert.ok(html.includes('does NOT cancel a subscription'));
});

test('onboarding.js wires the delete flow: typed DELETE + password, 401 keeps everything', () => {
  assert.ok(onboardingSrc.includes("'/api/auth/delete-account'"));
  assert.ok(onboardingSrc.includes("typed !== 'DELETE'"));
  assert.ok(onboardingSrc.includes("That password didn't match — nothing was deleted."));
});
