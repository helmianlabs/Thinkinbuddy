// test/usage.test.mjs — metering (lib/usage.js) with a fake in-memory
// db. No live Postgres: the fake implements exactly the three SQL
// shapes lib/usage.js issues (INSERT into usage_ledger, SUM over
// usage_ledger, SELECT from entitlements) over plain arrays, including
// the 23505 duplicate-key error pg raises on the request_id unique
// index — so the dedupe path is exercised for real.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CREDIT_COSTS,
  PLAN_GRANTS,
  costFor,
  bucketState,
  monthKey,
  recordUsage,
  safeRecordUsage,
  usageThisMonth,
  getEntitlement,
  checkBucket,
  shouldMeter,
  meterGate,
  denyMetering,
  recordMetered,
} from '../lib/usage.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

class FakeDb {
  constructor() {
    this.ledger = [];
    this.entitlements = new Map();
    this.queryCount = 0;
  }

  async query(sql, params = []) {
    this.queryCount += 1;
    if (/INSERT INTO usage_ledger/i.test(sql)) {
      const [tenantId, provider, unit, costMicros, requestId] = params;
      if (requestId && this.ledger.some((r) => r.request_id === requestId)) {
        const e = new Error('duplicate key value violates unique constraint "idx_usage_ledger_request_id"');
        e.code = '23505';
        throw e;
      }
      this.ledger.push({
        tenant_id: tenantId, provider, unit,
        cost_micros: costMicros, request_id: requestId, created_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/SUM\(cost_micros\)/i.test(sql) && /FROM usage_ledger/i.test(sql)) {
      const [tenantId, startIso, endIso] = params;
      const start = new Date(startIso);
      const end = new Date(endIso);
      const micros = this.ledger
        .filter((r) => r.tenant_id === tenantId && r.created_at >= start && r.created_at < end)
        .reduce((s, r) => s + Number(r.cost_micros), 0);
      return { rows: [{ micros }] };
    }
    if (/FROM entitlements/i.test(sql)) {
      const row = this.entitlements.get(params[0]) || null;
      return { rows: row ? [row] : [] };
    }
    throw new Error(`FakeDb: unexpected SQL: ${sql.slice(0, 90)}`);
  }

  seed({ tenantId, micros, at, requestId = null }) {
    this.ledger.push({
      tenant_id: tenantId, provider: 'seed', unit: 'seed',
      cost_micros: micros, request_id: requestId, created_at: at,
    });
  }
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

const SAVED_SECRET = process.env.SESSION_SECRET;
function withSecret(value, fn) {
  return async () => {
    if (value == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = value;
    try {
      return await fn();
    } finally {
      if (SAVED_SECRET == null) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = SAVED_SECRET;
    }
  };
}

describe('costFor', () => {
  it('chat message is the flat chat rate', () => {
    assert.equal(costFor('chat'), CREDIT_COSTS.chat);
    assert.equal(costFor('chat'), 1);
  });

  it('speak is per 100 chars, minimum 1', () => {
    assert.equal(costFor('speak', { chars: 0 }), 1);
    assert.equal(costFor('speak', { chars: 1 }), 1);
    assert.equal(costFor('speak', { chars: 100 }), 1);
    assert.equal(costFor('speak', { chars: 101 }), 2);
    assert.equal(costFor('speak', { chars: 250 }), 3);
    assert.equal(costFor('speak', { text: 'x'.repeat(200) }), 2);
  });

  it('image is the flat image rate', () => {
    assert.equal(costFor('image'), 5);
  });

  it('video is per second with the 30-credit floor', () => {
    assert.equal(costFor('video', { seconds: 0 }), 30); // floor
    assert.equal(costFor('video', { seconds: 2 }), 30); // floor beats 20
    assert.equal(costFor('video', { seconds: 3 }), 30); // 3*10 = floor
    assert.equal(costFor('video', { seconds: 5 }), 50);
    assert.equal(costFor('video', { seconds: 10 }), 100);
    assert.equal(costFor('video', { duration: 8 }), 80); // duration alias
    assert.equal(costFor('video', { seconds: 5.2 }), 60); // partial second rounds up
  });

  it('embedding and memory ops are free (documented in lib/usage.js)', () => {
    assert.equal(costFor('embedding'), 0);
    assert.equal(costFor('memory'), 0);
  });

  it('unknown action throws instead of silently charging 0', () => {
    assert.throws(() => costFor('teleport'), /unknown action/);
  });
});

describe('bucketState + monthKey', () => {
  it('remaining and exhausted edges', () => {
    assert.deepEqual(bucketState({ granted: 100, used: 30 }),
      { granted: 100, used: 30, remaining: 70, exhausted: false });
    assert.deepEqual(bucketState({ granted: 100, used: 100 }),
      { granted: 100, used: 100, remaining: 0, exhausted: true });
    assert.deepEqual(bucketState({ granted: 100, used: 150 }),
      { granted: 100, used: 150, remaining: 0, exhausted: true });
    assert.equal(bucketState({ granted: 0, used: 0 }).exhausted, true);
    assert.equal(bucketState({}).remaining, 0);
  });

  it('monthKey is UTC YYYY-MM', () => {
    assert.equal(monthKey(new Date(Date.UTC(2026, 9, 23))), '2026-10');
    assert.equal(monthKey(new Date(Date.UTC(2026, 0, 1))), '2026-01');
    assert.equal(monthKey(new Date(Date.UTC(2026, 11, 31, 23, 59))), '2026-12');
  });
});

describe('recordUsage / usageThisMonth', () => {
  it('inserts once, converting credits to cost_micros', async () => {
    const db = new FakeDb();
    const ok = await recordUsage(db, {
      tenantId: TENANT_A, provider: 'runway', action: 'video', units: 10, credits: 100, requestId: 'req-1',
    });
    assert.equal(ok, true);
    assert.equal(db.ledger.length, 1);
    assert.equal(db.ledger[0].cost_micros, 100_000);
    assert.equal(db.ledger[0].unit, 'video x10');
    assert.equal(db.ledger[0].provider, 'runway');
  });

  it('dedupes on request_id: a retried call is not double-charged', async () => {
    const db = new FakeDb();
    const args = { tenantId: TENANT_A, provider: 'openai', action: 'image', units: 1, credits: 5, requestId: 'req-dup' };
    assert.equal(await recordUsage(db, args), true);
    assert.equal(await recordUsage(db, args), false); // swallowed duplicate
    assert.equal(db.ledger.length, 1);
  });

  it('rows without a request_id always insert', async () => {
    const db = new FakeDb();
    const args = { tenantId: TENANT_A, provider: 'openai', action: 'chat', credits: 1 };
    assert.equal(await recordUsage(db, args), true);
    assert.equal(await recordUsage(db, args), true);
    assert.equal(db.ledger.length, 2);
  });

  it('usageThisMonth sums only this month and only that tenant', async () => {
    const db = new FakeDb();
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86_400_000);
    db.seed({ tenantId: TENANT_A, micros: 5000, at: now });
    db.seed({ tenantId: TENANT_A, micros: 7000, at: lastMonth });
    db.seed({ tenantId: TENANT_B, micros: 9000, at: now });
    assert.equal(await usageThisMonth(db, TENANT_A, now), 5);
    assert.equal(await usageThisMonth(db, TENANT_B, now), 9);
  });

  it('safeRecordUsage never throws on a broken db', async () => {
    const broken = { async query() { throw new Error('db down'); } };
    assert.equal(await safeRecordUsage(broken, {
      tenantId: TENANT_A, provider: 'runway', action: 'video', credits: 50, requestId: 'req-x',
    }), false);
  });
});

describe('checkBucket / PLAN_GRANTS', () => {
  it('grants match the plan table', () => {
    assert.deepEqual(PLAN_GRANTS, { free: 0, buddy: 10000, buddy_media: 25000, helmian_connect: 25000 });
  });

  it('buddy plan: grant minus this month usage', async () => {
    const db = new FakeDb();
    db.seed({ tenantId: TENANT_A, micros: 2_500_000, at: new Date() }); // 2500 credits
    const state = await checkBucket(db, TENANT_A, { plan: 'buddy' });
    assert.equal(state.plan, 'buddy');
    assert.equal(state.granted, 10000);
    assert.equal(state.used, 2500);
    assert.equal(state.remaining, 7500);
    assert.equal(state.exhausted, false);
  });

  it('looks the entitlement row up when planRow is omitted', async () => {
    const db = new FakeDb();
    db.entitlements.set(TENANT_A, { tenant_id: TENANT_A, plan: 'helmian_connect', status: 'active' });
    const state = await checkBucket(db, TENANT_A);
    assert.equal(state.plan, 'helmian_connect');
    assert.equal(state.granted, 25000);
    assert.deepEqual(await getEntitlement(db, TENANT_A),
      { tenant_id: TENANT_A, plan: 'helmian_connect', status: 'active' });
  });

  it('free and unknown plans grant 0 and read exhausted', async () => {
    const db = new FakeDb();
    assert.equal((await checkBucket(db, TENANT_A, { plan: 'free' })).exhausted, true);
    assert.equal((await checkBucket(db, TENANT_A, { plan: 'platinum' })).granted, 0);
    assert.equal((await checkBucket(db, TENANT_A, null)).granted, 0);
    assert.equal(await getEntitlement(db, TENANT_B), null);
  });
});

describe('shouldMeter — the BYO / compat matrix', () => {
  it('compat mode never meters', () => {
    assert.equal(shouldMeter({ enforced: false, keySource: 'env' }), false);
    assert.equal(shouldMeter({ enforced: false, keySource: 'user' }), false);
    assert.equal(shouldMeter({ enforced: false, keySource: 'none' }), false);
  });

  it('enforced mode skips only user (BYO) keys', () => {
    assert.equal(shouldMeter({ enforced: true, keySource: 'user' }), false);
    assert.equal(shouldMeter({ enforced: true, keySource: 'env' }), true);
    assert.equal(shouldMeter({ enforced: true, keySource: 'none' }), true);
  });
});

describe('meterGate', () => {
  it('compat mode: allowed, unmetered, and the db is never touched',
    withSecret(null, async () => {
      const db = new FakeDb();
      const gate = await meterGate({ db, tenantId: TENANT_A, keySource: 'env', estCredits: 50 });
      assert.deepEqual(gate, { meter: false, allowed: true, state: null });
      assert.equal(db.queryCount, 0);
    }));

  it('enforced + BYO user key: allowed, unmetered, db never touched',
    withSecret('test-secret', async () => {
      const db = new FakeDb();
      const gate = await meterGate({ db, tenantId: TENANT_A, keySource: 'user', estCredits: 50 });
      assert.equal(gate.meter, false);
      assert.equal(gate.allowed, true);
      assert.equal(db.queryCount, 0);
    }));

  it('enforced + server key + room in the bucket: allowed and metered',
    withSecret('test-secret', async () => {
      const db = new FakeDb();
      db.entitlements.set(TENANT_A, { tenant_id: TENANT_A, plan: 'buddy', status: 'active' });
      const gate = await meterGate({ db, tenantId: TENANT_A, keySource: 'env', estCredits: 100 });
      assert.equal(gate.meter, true);
      assert.equal(gate.allowed, true);
      assert.equal(gate.state.remaining, 10000);
    }));

  it('enforced + server key + free plan: denied credits_exhausted',
    withSecret('test-secret', async () => {
      const db = new FakeDb();
      db.entitlements.set(TENANT_A, { tenant_id: TENANT_A, plan: 'free', status: 'active' });
      const gate = await meterGate({ db, tenantId: TENANT_A, keySource: 'env', estCredits: 1 });
      assert.equal(gate.allowed, false);
      assert.equal(gate.reason, 'credits_exhausted');
      assert.equal(gate.state.remaining, 0);
    }));

  it('enforced + no tenant: denied tenant_required',
    withSecret('test-secret', async () => {
      const gate = await meterGate({ db: new FakeDb(), tenantId: null, keySource: 'env', estCredits: 1 });
      assert.equal(gate.allowed, false);
      assert.equal(gate.reason, 'tenant_required');
    }));

  it('enforced + bucket unreadable: fails closed as metering_unavailable',
    withSecret('test-secret', async () => {
      const broken = { async query() { throw new Error('db down'); } };
      const gate = await meterGate({ db: broken, tenantId: TENANT_A, keySource: 'env', estCredits: 1 });
      assert.equal(gate.allowed, false);
      assert.equal(gate.reason, 'metering_unavailable');
    }));

  it('denyMetering shapes: 402 exhausted, 503 unavailable, 401 no tenant', () => {
    const r1 = fakeRes();
    denyMetering(r1, { reason: 'credits_exhausted', state: { remaining: 0 } });
    assert.equal(r1.statusCode, 402);
    assert.deepEqual(r1.body, { error: 'credits_exhausted', remaining: 0 });
    const r2 = fakeRes();
    denyMetering(r2, { reason: 'metering_unavailable', state: null });
    assert.equal(r2.statusCode, 503);
    assert.deepEqual(r2.body, { error: 'metering_unavailable' });
    const r3 = fakeRes();
    denyMetering(r3, { reason: 'tenant_required', state: null });
    assert.equal(r3.statusCode, 401);
  });

  it('recordMetered writes only when the gate metered', async () => {
    const db = new FakeDb();
    const args = { tenantId: TENANT_A, provider: 'runway', action: 'video', units: 5, credits: 50, requestId: 'req-m' };
    assert.equal(await recordMetered({ meter: false }, db, args), false);
    assert.equal(db.ledger.length, 0);
    assert.equal(await recordMetered({ meter: true }, db, args), true);
    assert.equal(db.ledger.length, 1);
  });
});
