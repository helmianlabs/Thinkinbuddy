// test/billing.test.mjs — RevenueCat billing (lib/billing.js, the
// checkBucket grant extension in lib/usage.js, and the webhook
// handler's pre-DB gates) with a fake in-memory db. No live Postgres,
// no live RevenueCat: the fake implements exactly the SQL shapes the
// billing code issues (processed-events select/insert, entitlements
// upsert with COALESCE semantics, credit-grant insert + the 23505 the
// event_id unique index raises, grants sum, usage sum, entitlement
// select) over plain Maps/arrays.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCT_PLANS,
  CREDIT_PACKS,
  planForProduct,
  creditsForPack,
  verifyWebhook,
  planFromEvent,
  applyEvent,
} from '../lib/billing.js';
import { checkBucket } from '../lib/usage.js';
import billingWebhook from '../server/handlers/billing-webhook.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PERIOD_END_MS = Date.UTC(2026, 10, 23); // 2026-11-23

class FakeDb {
  constructor() {
    this.processed = new Map(); // event_id -> row
    this.entitlements = new Map(); // tenant_id -> row
    this.grants = []; // tenant_credit_grants rows
    this.ledger = []; // usage_ledger rows (checkBucket sums these)
  }

  async query(sql, params = []) {
    if (/SELECT event_id FROM processed_billing_events/i.test(sql)) {
      const row = this.processed.get(params[0]);
      return { rows: row ? [{ event_id: row.event_id }] : [] };
    }
    if (/INSERT INTO processed_billing_events/i.test(sql)) {
      const [eventId, type, tenantId] = params;
      if (!this.processed.has(eventId)) {
        this.processed.set(eventId, { event_id: eventId, type, tenant_id: tenantId });
      }
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO entitlements/i.test(sql)) {
      const [tenantId, plan, status, periodEnd] = params;
      const existing = this.entitlements.get(tenantId);
      this.entitlements.set(tenantId, {
        tenant_id: tenantId,
        plan: plan ?? existing?.plan ?? null, // COALESCE(EXCLUDED.plan, existing)
        status,
        current_period_end: periodEnd ?? existing?.current_period_end ?? null, // COALESCE
        revenuecat_app_user_id: tenantId,
      });
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO tenant_credit_grants/i.test(sql)) {
      const [tenantId, credits, eventId] = params;
      if (eventId && this.grants.some((g) => g.event_id === eventId)) {
        const e = new Error('duplicate key value violates unique constraint "idx_tenant_credit_grants_event_id"');
        e.code = '23505';
        throw e;
      }
      this.grants.push({
        tenant_id: tenantId, credits, source: 'credit_pack',
        event_id: eventId, expires_at: null, created_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM tenant_credit_grants/i.test(sql) && /SUM\(credits\)/i.test(sql)) {
      const [tenantId, nowIso] = params;
      const now = new Date(nowIso);
      const credits = this.grants
        .filter((g) => g.tenant_id === tenantId && (g.expires_at == null || new Date(g.expires_at) > now))
        .reduce((s, g) => s + Number(g.credits), 0);
      return { rows: [{ credits }] };
    }
    if (/SELECT[\s\S]*FROM entitlements/i.test(sql)) {
      const row = this.entitlements.get(params[0]) || null;
      return { rows: row ? [row] : [] };
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
    throw new Error(`FakeDb: unexpected SQL: ${sql.slice(0, 90)}`);
  }
}

let seq = 0;
function ev(overrides = {}) {
  seq += 1;
  return {
    id: `evt-${seq}`,
    type: 'INITIAL_PURCHASE',
    app_user_id: TENANT_A,
    product_id: 'tb_buddy_monthly',
    expiration_at_ms: PERIOD_END_MS,
    ...overrides,
  };
}

const SAVED_RC_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET;
function withRcSecret(value, fn) {
  return async () => {
    if (value == null) delete process.env.REVENUECAT_WEBHOOK_SECRET;
    else process.env.REVENUECAT_WEBHOOK_SECRET = value;
    try {
      return await fn();
    } finally {
      if (SAVED_RC_SECRET == null) delete process.env.REVENUECAT_WEBHOOK_SECRET;
      else process.env.REVENUECAT_WEBHOOK_SECRET = SAVED_RC_SECRET;
    }
  };
}

function fakeReqRes({ method = 'POST', headers = {}, body } = {}) {
  const req = { method, headers, body };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return { req, res };
}

describe('product maps', () => {
  it('subscription products map to the PLAN_GRANTS plan names', () => {
    assert.deepEqual(PRODUCT_PLANS, {
      tb_buddy_monthly: 'buddy', tb_buddy_yearly: 'buddy',
      tb_media_monthly: 'buddy_media', tb_media_yearly: 'buddy_media',
      tb_connect_monthly: 'helmian_connect', tb_connect_yearly: 'helmian_connect',
    });
    assert.equal(planForProduct('tb_connect_yearly'), 'helmian_connect');
    assert.equal(planForProduct('tb_nope'), null);
  });

  it('credit packs map to their credit counts', () => {
    assert.deepEqual(CREDIT_PACKS, { tb_credits_1000: 1000, tb_credits_5000: 5000, tb_credits_15000: 15000 });
    assert.equal(creditsForPack('tb_credits_5000'), 5000);
    assert.equal(creditsForPack('tb_buddy_monthly'), 0);
  });
});

describe('verifyWebhook', () => {
  it('unset secret fails closed', withRcSecret(null, async () => {
    assert.equal(verifyWebhook({ headers: { authorization: 'Bearer anything' } }), false);
    assert.equal(verifyWebhook({ headers: {} }), false);
  }));

  it('exact Bearer match passes; everything else fails', withRcSecret('s3cret-value', async () => {
    assert.equal(verifyWebhook({ headers: { authorization: 'Bearer s3cret-value' } }), true);
    assert.equal(verifyWebhook({ headers: { authorization: 'Bearer wrong' } }), false);
    assert.equal(verifyWebhook({ headers: { authorization: 's3cret-value' } }), false); // no Bearer prefix
    assert.equal(verifyWebhook({ headers: { authorization: 'Bearer s3cret-value ' } }), false); // trailing space
    assert.equal(verifyWebhook({ headers: {} }), false);
    assert.equal(verifyWebhook({}), false);
    assert.equal(verifyWebhook(null), false);
  }));
});

describe('planFromEvent', () => {
  it('purchase / renewal / product change -> active plan + period end', () => {
    for (const type of ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE']) {
      const a = planFromEvent(ev({ type, product_id: 'tb_media_yearly' }));
      assert.equal(a.kind, 'subscription');
      assert.equal(a.plan, 'buddy_media');
      assert.equal(a.status, 'active');
      assert.equal(a.tenantId, TENANT_A);
      assert.equal(a.currentPeriodEnd.getTime(), PERIOD_END_MS);
    }
  });

  it('cancellation -> status cancelled, plan kept until period end', () => {
    const a = planFromEvent(ev({ type: 'CANCELLATION' }));
    assert.equal(a.kind, 'subscription');
    assert.equal(a.status, 'cancelled');
    assert.equal(a.plan, 'buddy');
    assert.equal(a.currentPeriodEnd.getTime(), PERIOD_END_MS);
  });

  it('cancellation for an unmapped product is still a status-only change (plan null)', () => {
    const a = planFromEvent(ev({ type: 'CANCELLATION', product_id: 'legacy_thing' }));
    assert.equal(a.kind, 'subscription');
    assert.equal(a.status, 'cancelled');
    assert.equal(a.plan, null);
  });

  it('expiration -> plan free, status expired', () => {
    const a = planFromEvent(ev({ type: 'EXPIRATION' }));
    assert.equal(a.plan, 'free');
    assert.equal(a.status, 'expired');
  });

  it('billing issue -> status billing_issue, plan kept (mapped or null)', () => {
    const known = planFromEvent(ev({ type: 'BILLING_ISSUE', product_id: 'tb_connect_monthly' }));
    assert.equal(known.status, 'billing_issue');
    assert.equal(known.plan, 'helmian_connect');
    const unknown = planFromEvent(ev({ type: 'BILLING_ISSUE', product_id: 'legacy_thing' }));
    assert.equal(unknown.status, 'billing_issue');
    assert.equal(unknown.plan, null);
  });

  it('credit pack purchases -> credit_pack action with the pack size', () => {
    for (const type of ['INITIAL_PURCHASE', 'NON_RENEWAL_PURCHASE']) {
      const a = planFromEvent(ev({ type, product_id: 'tb_credits_15000' }));
      assert.equal(a.kind, 'credit_pack');
      assert.equal(a.credits, 15000);
      assert.equal(a.tenantId, TENANT_A);
    }
  });

  it('unapplicable events -> null (unknown product purchase, pack renewal, unknown type, no user)', () => {
    assert.equal(planFromEvent(ev({ product_id: 'tb_nope' })), null);
    assert.equal(planFromEvent(ev({ type: 'RENEWAL', product_id: 'tb_credits_1000' })), null);
    assert.equal(planFromEvent(ev({ type: 'TEST' })), null);
    assert.equal(planFromEvent(ev({ app_user_id: undefined })), null);
    assert.equal(planFromEvent(null), null);
    assert.equal(planFromEvent('a string'), null);
  });
});

describe('applyEvent', () => {
  it('subscription purchase upserts the entitlement with plan/status/period end', async () => {
    const db = new FakeDb();
    const r = await applyEvent(db, ev());
    assert.deepEqual(r, { applied: true, kind: 'subscription', tenantId: TENANT_A, plan: 'buddy' });
    const row = db.entitlements.get(TENANT_A);
    assert.equal(row.plan, 'buddy');
    assert.equal(row.status, 'active');
    assert.equal(row.current_period_end.getTime(), PERIOD_END_MS);
    assert.equal(row.revenuecat_app_user_id, TENANT_A);
    assert.equal(db.processed.size, 1);
  });

  it('renewal then cancellation then expiration walk the lifecycle', async () => {
    const db = new FakeDb();
    await applyEvent(db, ev());
    await applyEvent(db, ev({ type: 'RENEWAL', expiration_at_ms: PERIOD_END_MS + 86_400_000 }));
    let row = db.entitlements.get(TENANT_A);
    assert.equal(row.status, 'active');
    assert.equal(row.current_period_end.getTime(), PERIOD_END_MS + 86_400_000);
    await applyEvent(db, ev({ type: 'CANCELLATION' }));
    row = db.entitlements.get(TENANT_A);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.plan, 'buddy'); // plan kept until the period ends
    await applyEvent(db, ev({ type: 'EXPIRATION' }));
    row = db.entitlements.get(TENANT_A);
    assert.equal(row.status, 'expired');
    assert.equal(row.plan, 'free');
  });

  it('status-only cancellation (unmapped product) does not clobber an existing plan', async () => {
    const db = new FakeDb();
    await applyEvent(db, ev()); // buddy active
    await applyEvent(db, ev({ type: 'CANCELLATION', product_id: 'legacy_thing' }));
    const row = db.entitlements.get(TENANT_A);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.plan, 'buddy');
  });

  it('a duplicate event id applies at most once', async () => {
    const db = new FakeDb();
    const e = ev({ type: 'NON_RENEWAL_PURCHASE', product_id: 'tb_credits_1000' });
    assert.equal((await applyEvent(db, e)).applied, true);
    assert.deepEqual(await applyEvent(db, e), { applied: false, reason: 'duplicate' });
    assert.equal(db.grants.length, 1);
    assert.equal(db.processed.size, 1);
  });

  it('unknown product: recorded, not applied, no entitlement written', async () => {
    const db = new FakeDb();
    const e = ev({ product_id: 'tb_nope' });
    assert.deepEqual(await applyEvent(db, e),
      { applied: false, reason: 'unknown_product', tenantId: TENANT_A });
    assert.equal(db.entitlements.size, 0);
    assert.equal(db.processed.size, 1); // recorded — a replay is a duplicate
    assert.deepEqual(await applyEvent(db, e), { applied: false, reason: 'duplicate' });
  });

  it('unknown event type: recorded, not applied, never throws', async () => {
    const db = new FakeDb();
    const r = await applyEvent(db, ev({ type: 'SOME_FUTURE_EVENT' }));
    assert.equal(r.applied, false);
    assert.equal(db.processed.size, 1);
    assert.equal(db.entitlements.size, 0);
  });

  it('an event with no id is invalid and nothing is recorded', async () => {
    const db = new FakeDb();
    assert.deepEqual(await applyEvent(db, { type: 'INITIAL_PURCHASE', app_user_id: TENANT_A }),
      { applied: false, reason: 'invalid_event' });
    assert.deepEqual(await applyEvent(db, null), { applied: false, reason: 'invalid_event' });
    assert.equal(db.processed.size, 0);
  });

  it('an event with no app_user_id is recorded unattributed and not applied', async () => {
    const db = new FakeDb();
    const e = ev({ app_user_id: undefined });
    const r = await applyEvent(db, e);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'missing_app_user_id');
    assert.equal(db.processed.size, 1);
    assert.equal(db.processed.get(e.id)?.tenant_id ?? null, null);
  });

  it('tenants are independent: an event for B touches only B', async () => {
    const db = new FakeDb();
    await applyEvent(db, ev({ app_user_id: TENANT_B, product_id: 'tb_connect_yearly' }));
    assert.equal(db.entitlements.get(TENANT_B).plan, 'helmian_connect');
    assert.equal(db.entitlements.has(TENANT_A), false);
  });
});

describe('credit packs + checkBucket', () => {
  it('a pack purchase inserts a grant and checkBucket includes it on top of the plan', async () => {
    const db = new FakeDb();
    await applyEvent(db, ev()); // buddy plan
    const r = await applyEvent(db, ev({ type: 'NON_RENEWAL_PURCHASE', product_id: 'tb_credits_5000' }));
    assert.deepEqual(r, { applied: true, kind: 'credit_pack', tenantId: TENANT_A, credits: 5000 });
    assert.equal(db.grants.length, 1);
    assert.equal(db.grants[0].source, 'credit_pack');
    const state = await checkBucket(db, TENANT_A);
    assert.equal(state.plan, 'buddy');
    assert.equal(state.grants, 5000);
    assert.equal(state.granted, 10000 + 5000);
    assert.equal(state.remaining, 15000);
  });

  it('packs give a free-plan tenant spendable credits', async () => {
    const db = new FakeDb();
    await applyEvent(db, ev({ type: 'EXPIRATION' })); // free/expired row
    await applyEvent(db, ev({ product_id: 'tb_credits_1000' })); // INITIAL_PURCHASE pack
    const state = await checkBucket(db, TENANT_A);
    assert.equal(state.plan, 'free');
    assert.equal(state.granted, 1000);
    assert.equal(state.exhausted, false);
  });

  it('an expired grant is excluded from checkBucket', async () => {
    const db = new FakeDb();
    db.grants.push({
      tenant_id: TENANT_A, credits: 7000, source: 'promo',
      event_id: null, expires_at: new Date(Date.now() - 86_400_000), created_at: new Date(),
    });
    db.grants.push({
      tenant_id: TENANT_A, credits: 1000, source: 'promo',
      event_id: null, expires_at: new Date(Date.now() + 86_400_000), created_at: new Date(),
    });
    const state = await checkBucket(db, TENANT_A, { plan: 'free' });
    assert.equal(state.grants, 1000);
    assert.equal(state.granted, 1000);
  });
});

describe('billing-webhook handler gates (pre-DB)', () => {
  it('non-POST -> 405', async () => {
    const { req, res } = fakeReqRes({ method: 'GET' });
    await billingWebhook(req, res);
    assert.equal(res.statusCode, 405);
  });

  it('unset webhook secret -> 401 (fail closed)', withRcSecret(null, async () => {
    const { req, res } = fakeReqRes({ headers: { authorization: 'Bearer x' }, body: { event: ev() } });
    await billingWebhook(req, res);
    assert.equal(res.statusCode, 401);
  }));

  it('wrong secret -> 401', withRcSecret('right-secret', async () => {
    const { req, res } = fakeReqRes({ headers: { authorization: 'Bearer wrong-secret' }, body: { event: ev() } });
    await billingWebhook(req, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
  }));

  it('malformed JSON body with a valid secret -> 400', withRcSecret('right-secret', async () => {
    const { req, res } = fakeReqRes({ headers: { authorization: 'Bearer right-secret' }, body: '{not json' });
    await billingWebhook(req, res);
    assert.equal(res.statusCode, 400);
  }));

  it('a body without an event object -> 400', withRcSecret('right-secret', async () => {
    const { req, res } = fakeReqRes({ headers: { authorization: 'Bearer right-secret' }, body: { hello: 'world' } });
    await billingWebhook(req, res);
    assert.equal(res.statusCode, 400);
  }));
});
