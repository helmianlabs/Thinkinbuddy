// test/tenant-wiring.test.mjs — wiring-bite coverage for lib/tenant.js.
//
// Bite 1's test/tenant.test.mjs covers the token primitives in enforced
// mode (explicit secret everywhere). This file covers what the wiring
// bite added and what the handlers actually depend on:
//
//   - COMPAT mode: no SESSION_SECRET -> resolveTenant returns the legacy
//     tenant (never null, never a 401 via requireTenant), and the
//     scoping helpers report "no scoping tenant", which is the signal
//     every wired handler uses to run its original pre-wiring queries.
//   - ENFORCED mode: secret set -> a request with no/invalid token
//     resolves to null (requireTenant writes the 401), a valid token
//     resolves to its tenant, and resolveHandlerTenant (the tool/webhook
//     handlers' resolver) additionally accepts the tenant id carried as
//     the user_id value — and nothing else.
//   - The scoping predicate the handlers' SQL mirrors
//     (`AND tenant_id = $n`): tenantPredicate / scopeToTenant over
//     interleaved two-tenant rows.
//
// Env care: tenantEnforced/resolveTenant default to
// process.env.SESSION_SECRET, so compat tests pass an explicit empty
// secret ('' / undefined-equivalent) instead of mutating process.env —
// except the two tests marked ENV, which save/restore it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_TENANT_ID,
  SESSION_SECRET_ENV,
  signSession,
  resolveTenant,
  requireTenant,
  tenantEnforced,
  activeTenantId,
  resolveHandlerTenant,
  isTenantId,
  tenantPredicate,
  scopeToTenant,
} from '../lib/tenant.js';

const SECRET = 'wiring-test-secret-not-a-real-one';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function bearerReq(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

describe('tenantEnforced — the compat/enforced switch', () => {
  it('is false for an unset or empty secret, true for a set one', () => {
    assert.equal(tenantEnforced(''), false);
    assert.equal(tenantEnforced(undefined), false);
    assert.equal(tenantEnforced(null), false);
    assert.equal(tenantEnforced(SECRET), true);
  });
});

describe('compat mode (no SESSION_SECRET) — the live app must not notice', () => {
  it('resolveTenant returns the legacy tenant, with or without headers', () => {
    assert.deepEqual(resolveTenant({ headers: {} }, ''), { tenantId: LEGACY_TENANT_ID });
    assert.deepEqual(resolveTenant({}, ''), { tenantId: LEGACY_TENANT_ID });
    assert.deepEqual(resolveTenant(null, ''), { tenantId: LEGACY_TENANT_ID });
    // Even a garbage Bearer header cannot fail compat resolution.
    assert.deepEqual(
      resolveTenant(bearerReq('a.b.c'), ''),
      { tenantId: LEGACY_TENANT_ID },
    );
  });

  it('requireTenant returns the legacy tenant and writes NO 401', () => {
    const res = mockRes();
    assert.deepEqual(requireTenant({ headers: {} }, res, ''), { tenantId: LEGACY_TENANT_ID });
    assert.equal(res.statusCode, null);
    assert.equal(res.body, null);
  });

  it('activeTenantId reports no scoping tenant in compat mode', () => {
    // This null is the handlers' signal to run their original queries.
    assert.equal(activeTenantId({ tenantId: LEGACY_TENANT_ID }, ''), null);
    assert.equal(activeTenantId(null, ''), null);
  });

  it('resolveHandlerTenant is ok with tenantId null in compat mode', () => {
    assert.deepEqual(
      resolveHandlerTenant({ headers: {} }, 'troy', ''),
      { tenantId: null, enforced: false, ok: true },
    );
    // The legacy 'troy' userId is not (and must not become) a tenant id.
    assert.deepEqual(
      resolveHandlerTenant({ headers: {} }, undefined, ''),
      { tenantId: null, enforced: false, ok: true },
    );
  });

  it('ENV: with SESSION_SECRET removed from the environment, defaults are compat', () => {
    const saved = process.env[SESSION_SECRET_ENV];
    delete process.env[SESSION_SECRET_ENV];
    try {
      assert.equal(tenantEnforced(), false);
      assert.deepEqual(resolveTenant({ headers: {} }), { tenantId: LEGACY_TENANT_ID });
    } finally {
      if (saved !== undefined) process.env[SESSION_SECRET_ENV] = saved;
    }
  });
});

describe('enforced mode (SESSION_SECRET set) — no token, no tenant', () => {
  it('resolveTenant returns null without a valid Bearer token', () => {
    assert.equal(resolveTenant({ headers: {} }, SECRET), null);
    assert.equal(resolveTenant(bearerReq('a.b.c'), SECRET), null);
  });

  it('requireTenant writes the 401 and returns null', () => {
    const res = mockRes();
    assert.equal(requireTenant({ headers: {} }, res, SECRET), null);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
  });

  it('a valid token resolves to its tenant and scopes actively', () => {
    const token = signSession(TENANT_A, SECRET, 600);
    const tenant = resolveTenant(bearerReq(token), SECRET);
    assert.deepEqual(tenant, { tenantId: TENANT_A });
    assert.equal(activeTenantId(tenant, SECRET), TENANT_A);
  });

  it('resolveHandlerTenant: valid token wins', () => {
    const token = signSession(TENANT_B, SECRET, 600);
    assert.deepEqual(
      resolveHandlerTenant(bearerReq(token), 'troy', SECRET),
      { tenantId: TENANT_B, enforced: true, ok: true },
    );
  });

  it('resolveHandlerTenant: tenant id carried as user_id resolves', () => {
    // The ElevenLabs tool/webhook path: no header, user_id IS the tenant id.
    assert.deepEqual(
      resolveHandlerTenant({ headers: {} }, TENANT_A, SECRET),
      { tenantId: TENANT_A, enforced: true, ok: true },
    );
  });

  it('resolveHandlerTenant: neither token nor tenant user_id -> not ok, no default', () => {
    assert.deepEqual(
      resolveHandlerTenant({ headers: {} }, 'troy', SECRET),
      { tenantId: null, enforced: true, ok: false },
    );
    assert.deepEqual(
      resolveHandlerTenant({ headers: {} }, undefined, SECRET),
      { tenantId: null, enforced: true, ok: false },
    );
    assert.deepEqual(
      resolveHandlerTenant(bearerReq('a.b.c'), 'not-a-uuid', SECRET),
      { tenantId: null, enforced: true, ok: false },
    );
  });

  it('ENV: with SESSION_SECRET set in the environment, defaults are enforced', () => {
    const saved = process.env[SESSION_SECRET_ENV];
    process.env[SESSION_SECRET_ENV] = SECRET;
    try {
      assert.equal(tenantEnforced(), true);
      assert.equal(resolveTenant({ headers: {} }), null);
    } finally {
      if (saved === undefined) delete process.env[SESSION_SECRET_ENV];
      else process.env[SESSION_SECRET_ENV] = saved;
    }
  });
});

describe('isTenantId', () => {
  it('accepts UUIDs and rejects legacy/user values', () => {
    assert.equal(isTenantId(TENANT_A), true);
    assert.equal(isTenantId(LEGACY_TENANT_ID), true);
    assert.equal(isTenantId('troy'), false);
    assert.equal(isTenantId('anonymous'), false);
    assert.equal(isTenantId(''), false);
    assert.equal(isTenantId(null), false);
    assert.equal(isTenantId(undefined), false);
    assert.equal(isTenantId(42), false);
  });
});

describe('the scoping predicate (tenantPredicate / scopeToTenant)', () => {
  // Interleaved rows shaped like memory_items / conversation rows after
  // sql/store/002 stamped tenant_id on them.
  const rows = [
    { id: 1, tenant_id: TENANT_A, content: 'a-1' },
    { id: 2, tenant_id: TENANT_B, content: 'b-1' },
    { id: 3, tenant_id: TENANT_A, content: 'a-2' },
    { id: 4, tenant_id: TENANT_B, content: 'b-2' },
    { id: 5, tenant_id: LEGACY_TENANT_ID, content: 'legacy-1' },
  ];

  it('tenantPredicate matches only the row owner', () => {
    assert.equal(tenantPredicate(rows[0], TENANT_A), true);
    assert.equal(tenantPredicate(rows[0], TENANT_B), false);
    assert.equal(tenantPredicate(rows[0], null), false);
    assert.equal(tenantPredicate(null, TENANT_A), false);
    assert.equal(tenantPredicate({ id: 9 }, TENANT_A), false);
  });

  it('scopeToTenant over interleaved rows leaks nothing either way', () => {
    assert.deepEqual(scopeToTenant(rows, TENANT_A).map((r) => r.id), [1, 3]);
    assert.deepEqual(scopeToTenant(rows, TENANT_B).map((r) => r.id), [2, 4]);
    assert.deepEqual(scopeToTenant(rows, LEGACY_TENANT_ID).map((r) => r.id), [5]);
  });

  it('the predicate mirrors the handlers SQL filter semantics', () => {
    // `WHERE tenant_id = $tenant` over the same rows must equal
    // scopeToTenant — this is the invariant every wired handler relies on.
    for (const t of [TENANT_A, TENANT_B, LEGACY_TENANT_ID]) {
      const sqlSide = rows.filter((r) => r.tenant_id === t);
      assert.deepEqual(scopeToTenant(rows, t), sqlSide);
    }
  });
});
