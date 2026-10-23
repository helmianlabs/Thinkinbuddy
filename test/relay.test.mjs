// test/relay.test.mjs — Helmian Connect relay bite: tenant channels,
// pairing codes, device tokens, the Connect entitlement gate, and the
// /api/relay/* handler shapes. Fake db, no live database. The handler
// tests pin the EXACT functions the production handlers call
// (lib/relay.js + handleRelayPair), and the static tests pin the
// client/router wiring (public/connect.js, the /connect.js include,
// the relay-pair route) the way test/onboarding-ui.test.mjs pins
// bite 5b's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  channelForTenant, createPairingCode, redeemPairingCode,
  authenticateDevice, authenticateDeviceRecord, requireConnectEntitlement,
  recordDeviceSeen, listDevices, revokeDevice, hashDeviceToken,
  PAIRING_CODE_TTL_MS,
} from '../lib/relay.js';
import { createAccount } from '../lib/accounts.js';
import { signSession } from '../lib/tenant.js';
import { handleRelayPair } from '../server/handlers/relay-pair.js';
import { FakeDb } from './fake-db.mjs';

const SECRET = 'relay-test-secret';
process.env.SESSION_SECRET = SECRET;

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

// ─── Fake db: FakeDb (tenants/profiles/entitlements) + relay tables ────

function insertRow(s, params) {
  const m = s.match(/INSERT INTO \w+ \(([^)]+)\)/i);
  const cols = m[1].split(',').map((x) => x.trim());
  const row = {};
  cols.forEach((c, i) => { row[c] = params[i]; });
  return row;
}

class RelayFakeDb extends FakeDb {
  constructor() {
    super();
    this.pairingCodes = [];
    this.devices = [];
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/relay_pairing_codes|relay_devices/i.test(s)) return this.relayQuery(s, params);
    return super.query(sql, params);
  }

  relayQuery(s, params) {
    if (/^UPDATE relay_pairing_codes SET used_at/i.test(s) && /WHERE tenant_id/i.test(s)) {
      let n = 0;
      for (const c of this.pairingCodes) {
        if (c.tenant_id === params[0] && c.used_at == null) { c.used_at = params[1]; n += 1; }
      }
      return { rows: [], rowCount: n };
    }
    if (/^INSERT INTO relay_pairing_codes/i.test(s)) {
      const row = insertRow(s, params);
      row.used_at = null;
      row.created_at = new Date().toISOString();
      this.pairingCodes.push(row);
      return { rows: [] };
    }
    if (/^SELECT id, tenant_id FROM relay_pairing_codes/i.test(s)) {
      const rows = this.pairingCodes.filter(
        (c) => c.code_hash === params[0] && c.used_at == null && c.expires_at > params[1],
      );
      return { rows: rows.map((r) => ({ ...r })) };
    }
    if (/^UPDATE relay_pairing_codes SET used_at/i.test(s) && /WHERE id/i.test(s)) {
      const row = this.pairingCodes.find((c) => c.id === params[0]);
      if (!row || row.used_at != null) return { rows: [], rowCount: 0 };
      row.used_at = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO relay_devices/i.test(s)) {
      const row = insertRow(s, params);
      row.paired_at = new Date().toISOString();
      row.last_seen_at = null;
      row.revoked_at = null;
      this.devices.push(row);
      return { rows: [] };
    }
    if (/^SELECT id, tenant_id, device_label FROM relay_devices/i.test(s)) {
      const row = this.devices.find(
        (d) => d.device_token_hash === params[0] && d.revoked_at == null,
      );
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/^UPDATE relay_devices SET last_seen_at/i.test(s)) {
      const row = this.devices.find((d) => d.id === params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.last_seen_at = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT id, device_label, paired_at, last_seen_at, revoked_at FROM relay_devices/i.test(s)) {
      const rows = this.devices
        .filter((d) => d.tenant_id === params[0])
        .sort((a, b) => (a.paired_at < b.paired_at ? 1 : -1));
      return { rows: rows.map((r) => ({ ...r })) };
    }
    if (/^UPDATE relay_devices SET revoked_at/i.test(s)) {
      const row = this.devices.find((d) => d.id === params[0]);
      if (!row || row.tenant_id !== params[1] || row.revoked_at != null) {
        return { rows: [], rowCount: 0 };
      }
      row.revoked_at = params[2];
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`RelayFakeDb: unhandled SQL: ${s.slice(0, 140)}`);
  }
}

function setEntitlement(db, tenantId, plan, status) {
  db.entitlements.set(tenantId, {
    tenant_id: tenantId, plan, status,
    current_period_end: null, revenuecat_app_user_id: null,
  });
}

async function tenantWithPlan(db, plan, status) {
  const { tenantId } = await createAccount(db, {
    email: `u${Math.random().toString(36).slice(2, 10)}@example.com`,
    password: 'a long passphrase',
  });
  if (plan !== undefined) setEntitlement(db, tenantId, plan, status);
  return tenantId;
}

// ─── channelForTenant ──────────────────────────────────────────────────

test('channelForTenant is deterministic and well-shaped', () => {
  const a = channelForTenant(TENANT_A);
  assert.equal(a, channelForTenant(TENANT_A));
  assert.match(a, /^t-[0-9a-f]{16}$/);
  // relay-http's channel rule, copied from server/handlers/relay-http.js
  assert.match(a, /^[a-z0-9][a-z0-9_-]{1,62}$/);
});

test('channelForTenant never collides across tenants', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const ch = channelForTenant(id);
    assert.ok(!seen.has(ch), `collision at ${id}`);
    seen.add(ch);
  }
  assert.notEqual(channelForTenant(TENANT_A), channelForTenant(TENANT_B));
});

// ─── Pairing codes + devices ───────────────────────────────────────────

test('pairing happy path: create -> redeem -> the device token authenticates', async () => {
  const db = new RelayFakeDb();
  const tenantId = await tenantWithPlan(db, 'helmian_connect', 'active');
  const { code, expiresAt } = await createPairingCode(db, tenantId);
  assert.match(code, /^\d{6}$/);
  assert.ok(Math.abs(new Date(expiresAt).getTime() - (Date.now() + PAIRING_CODE_TTL_MS)) < 5000);

  const redeemed = await redeemPairingCode(db, code, 'Studio PC');
  assert.equal(redeemed.tenantId, tenantId);
  assert.ok(redeemed.deviceId);
  assert.match(redeemed.deviceToken, /^[0-9a-f]{64}$/);

  assert.equal(await authenticateDevice(db, redeemed.deviceToken), tenantId);
  const record = await authenticateDeviceRecord(db, redeemed.deviceToken);
  assert.equal(record.deviceId, redeemed.deviceId);
  assert.equal(record.deviceLabel, 'Studio PC');

  // Only the hash is stored — the raw token appears nowhere in the db.
  assert.ok(!JSON.stringify(db.devices).includes(redeemed.deviceToken));
  assert.equal(db.devices[0].device_token_hash, hashDeviceToken(redeemed.deviceToken));
});

test('an expired pairing code fails', async () => {
  const db = new RelayFakeDb();
  const tenantId = await tenantWithPlan(db, 'helmian_connect', 'active');
  const t0 = new Date('2026-01-01T00:00:00.000Z');
  const { code } = await createPairingCode(db, tenantId, t0);
  const after = new Date(t0.getTime() + PAIRING_CODE_TTL_MS + 60_000);
  assert.equal(await redeemPairingCode(db, code, 'Late PC', after), null);
  // ...and succeeds one minute BEFORE expiry, proving the boundary is the TTL.
  const before = new Date(t0.getTime() + PAIRING_CODE_TTL_MS - 60_000);
  const ok = await redeemPairingCode(db, code, 'In-time PC', before);
  assert.equal(ok.tenantId, tenantId);
});

test('a used pairing code cannot be redeemed twice', async () => {
  const db = new RelayFakeDb();
  const tenantId = await tenantWithPlan(db, 'helmian_connect', 'active');
  const { code } = await createPairingCode(db, tenantId);
  assert.ok(await redeemPairingCode(db, code, 'First PC'));
  assert.equal(await redeemPairingCode(db, code, 'Second PC'), null);
  assert.equal(db.devices.length, 1); // the failed redeem created nothing
});

test('minting a new code invalidates the previous unused code', async () => {
  const db = new RelayFakeDb();
  const tenantId = await tenantWithPlan(db, 'helmian_connect', 'active');
  const first = await createPairingCode(db, tenantId);
  let second = await createPairingCode(db, tenantId);
  // Guard the 1-in-a-million same-code flake: remint until distinct.
  for (let i = 0; i < 5 && second.code === first.code; i += 1) {
    second = await createPairingCode(db, tenantId);
  }
  assert.notEqual(second.code, first.code);
  assert.equal(await redeemPairingCode(db, first.code, 'Stale-code PC'), null);
  const ok = await redeemPairingCode(db, second.code, 'Fresh-code PC');
  assert.equal(ok.tenantId, tenantId);
});

test('authenticateDevice: unknown token fails, a revoked device fails', async () => {
  const db = new RelayFakeDb();
  const tenantId = await tenantWithPlan(db, 'helmian_connect', 'active');
  assert.equal(await authenticateDevice(db, 'f'.repeat(64)), null);
  assert.equal(await authenticateDevice(db, ''), null);
  assert.equal(await authenticateDevice(db, null), null);

  const { code } = await createPairingCode(db, tenantId);
  const { deviceId, deviceToken } = await redeemPairingCode(db, code, 'Doomed PC');
  assert.equal(await authenticateDevice(db, deviceToken), tenantId);
  assert.equal(await revokeDevice(db, tenantId, deviceId), true);
  assert.equal(await authenticateDevice(db, deviceToken), null);
});

test('recordDeviceSeen stamps last_seen_at; listDevices carries no token material', async () => {
  const db = new RelayFakeDb();
  const tenantId = await tenantWithPlan(db, 'helmian_connect', 'active');
  const { code } = await createPairingCode(db, tenantId);
  const { deviceId, deviceToken } = await redeemPairingCode(db, code, 'Kitchen PC');

  let devices = await listDevices(db, tenantId);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].device_label, 'Kitchen PC');
  assert.equal(devices[0].last_seen_at, null);

  assert.equal(await recordDeviceSeen(db, deviceId), true);
  devices = await listDevices(db, tenantId);
  assert.ok(devices[0].last_seen_at);
  const serialized = JSON.stringify(devices);
  assert.ok(!serialized.includes(deviceToken));
  assert.ok(!serialized.includes(hashDeviceToken(deviceToken)));
  assert.ok(!('device_token_hash' in devices[0]));
});

test("revokeDevice: a tenant cannot revoke another tenant's device", async () => {
  const db = new RelayFakeDb();
  const owner = await tenantWithPlan(db, 'helmian_connect', 'active');
  const other = await tenantWithPlan(db, 'helmian_connect', 'active');
  const { code } = await createPairingCode(db, owner);
  const { deviceId, deviceToken } = await redeemPairingCode(db, code, 'Owner PC');
  assert.equal(await revokeDevice(db, other, deviceId), false);
  assert.equal(await authenticateDevice(db, deviceToken), owner); // still live
  assert.equal(await revokeDevice(db, owner, deviceId), true);
  assert.equal(await revokeDevice(db, owner, deviceId), false); // already revoked
});

// ─── Entitlement gate ──────────────────────────────────────────────────

test('requireConnectEntitlement matrix: only helmian_connect + active/trialing pass', async () => {
  const db = new RelayFakeDb();
  const cases = [
    ['buddy', 'active', false],
    ['buddy_media', 'active', false],
    ['free', 'active', false],
    ['helmian_connect', 'active', true],
    ['helmian_connect', 'trialing', true],
    ['helmian_connect', 'expired', false],
    ['helmian_connect', 'cancelled', false],
    ['helmian_connect', 'billing_issue', false],
    ['helmian_connect', 'none', false],
  ];
  for (const [plan, status, expected] of cases) {
    const tenantId = await tenantWithPlan(db, plan, status);
    assert.equal(
      await requireConnectEntitlement(db, tenantId),
      expected,
      `${plan}/${status} should be ${expected}`,
    );
  }
  // No entitlement row at all -> false. No tenant -> false.
  const bare = await tenantWithPlan(db, undefined);
  db.entitlements.delete(bare);
  assert.equal(await requireConnectEntitlement(db, bare), false);
  assert.equal(await requireConnectEntitlement(db, null), false);
});

// ─── /api/relay/* handler ──────────────────────────────────────────────

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    writeHead(c) { this.statusCode = c; return this; },
    end(s) { this.body = JSON.parse(s); return this; },
  };
  return res;
}

function reqFor(tenantId, { method = 'POST', url = 'http://local/api/relay/pair/create', body = {} } = {}) {
  return {
    method,
    url,
    headers: tenantId
      ? { authorization: `Bearer ${signSession(tenantId, SECRET)}` }
      : {},
    body,
  };
}

test('handler: pair/create without the Connect plan -> 403 helmian_connect_required', async () => {
  const db = new RelayFakeDb();
  for (const [plan, status] of [['buddy', 'active'], ['free', 'active'], ['helmian_connect', 'expired']]) {
    const tenantId = await tenantWithPlan(db, plan, status);
    const res = fakeRes();
    await handleRelayPair(reqFor(tenantId), res, db);
    assert.equal(res.statusCode, 403, `${plan}/${status}`);
    assert.deepEqual(res.body, { error: 'helmian_connect_required' });
  }
  assert.equal(db.pairingCodes.length, 0); // no code was ever minted
});

test('handler: pair/create with Connect -> 200 { code, expiresAt }; no session -> 401; compat -> 503', async () => {
  const db = new RelayFakeDb();
  const tenantId = await tenantWithPlan(db, 'helmian_connect', 'trialing');
  const res = fakeRes();
  await handleRelayPair(reqFor(tenantId), res, db);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.code, /^\d{6}$/);
  assert.ok(res.body.expiresAt);

  const anon = fakeRes();
  await handleRelayPair(reqFor(null), anon, db);
  assert.equal(anon.statusCode, 401);

  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const compat = fakeRes();
    await handleRelayPair(reqFor(tenantId), compat, db);
    assert.equal(compat.statusCode, 503);
    assert.deepEqual(compat.body, { error: 'accounts_not_configured' });
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

test('handler: full pairing round trip — create, redeem, devices, revoke', async () => {
  const db = new RelayFakeDb();
  const tenantId = await tenantWithPlan(db, 'helmian_connect', 'active');

  const create = fakeRes();
  await handleRelayPair(reqFor(tenantId), create, db);
  assert.equal(create.statusCode, 200);

  const redeem = fakeRes();
  await handleRelayPair(reqFor(null, {
    url: 'http://local/api/relay/pair/redeem',
    body: { code: create.body.code, deviceLabel: 'Den PC' },
  }), redeem, db);
  assert.equal(redeem.statusCode, 200);
  assert.match(redeem.body.deviceToken, /^[0-9a-f]{64}$/);
  assert.equal(redeem.body.channel, channelForTenant(tenantId));
  assert.equal(await authenticateDevice(db, redeem.body.deviceToken), tenantId);

  // The same code through the handler again -> 401, single-use holds.
  const again = fakeRes();
  await handleRelayPair(reqFor(null, {
    url: 'http://local/api/relay/pair/redeem',
    body: { code: create.body.code, deviceLabel: 'Sneaky PC' },
  }), again, db);
  assert.equal(again.statusCode, 401);
  assert.deepEqual(again.body, { error: 'invalid_or_expired_code' });

  const list = fakeRes();
  await handleRelayPair(reqFor(tenantId, {
    method: 'GET', url: 'http://local/api/relay/devices',
  }), list, db);
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.devices.length, 1);
  assert.equal(list.body.devices[0].device_label, 'Den PC');
  assert.ok(!JSON.stringify(list.body).includes(redeem.body.deviceToken));

  const revoke = fakeRes();
  await handleRelayPair(reqFor(tenantId, {
    url: 'http://local/api/relay/pair/revoke',
    body: { deviceId: redeem.body.deviceId },
  }), revoke, db);
  assert.equal(revoke.statusCode, 200);
  assert.deepEqual(revoke.body, { ok: true });
  assert.equal(await authenticateDevice(db, redeem.body.deviceToken), null);

  const revokeAgain = fakeRes();
  await handleRelayPair(reqFor(tenantId, {
    url: 'http://local/api/relay/pair/revoke',
    body: { deviceId: redeem.body.deviceId },
  }), revokeAgain, db);
  assert.equal(revokeAgain.statusCode, 404);
  assert.deepEqual(revokeAgain.body, { error: 'device_not_found' });
});

// ─── Static wiring: connect.js, index.html, router, SQL ────────────────

const root = fileURLToPath(new URL('..', import.meta.url));
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const connectJs = readFileSync(new URL('../public/connect.js', import.meta.url), 'utf8');
const routerJs = readFileSync(`${root}api/[...path].js`, 'utf8');
const relaySql = readFileSync(new URL('../sql/store/005_relay.sql', import.meta.url), 'utf8');

test('public/connect.js parses as a valid ES module (node --check)', () => {
  execFileSync(process.execPath, ['--check', `${root}public/connect.js`], { stdio: 'pipe' });
});

test('index.html loads /connect.js exactly once, the public-at-root way', () => {
  const needle = '<script type="module" src="/connect.js"></script>';
  assert.equal(indexHtml.split(needle).length - 1, 1);
});

test('router registers the relay-pair handler', () => {
  assert.ok(routerJs.includes("'relay-pair': () => import('../server/handlers/relay-pair.js')"));
});

test('connect.js talks to the exact pairing endpoints + carries the upsell line verbatim', () => {
  for (const path of ['/api/relay/pair/create', '/api/relay/pair/revoke', '/api/relay/devices', '/api/profile']) {
    assert.ok(connectJs.includes(path), `missing endpoint string ${path}`);
  }
  assert.ok(connectJs.includes(
    'Helmian Connect — give your buddy hands on your computer. Available on the Helmian Connect plan.',
  ));
  assert.ok(connectJs.includes('accountPane'));
});

test('005_relay.sql creates the pairing tables and the guarded tenant_id add', () => {
  assert.ok(relaySql.includes('CREATE TABLE IF NOT EXISTS relay_devices'));
  assert.ok(relaySql.includes('CREATE TABLE IF NOT EXISTS relay_pairing_codes'));
  assert.ok(relaySql.includes('ADD COLUMN IF NOT EXISTS tenant_id'));
  assert.ok(relaySql.includes('device_token_hash'));
  assert.ok(relaySql.includes('code_hash'));
});
