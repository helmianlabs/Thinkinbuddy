import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  signSession,
  verifySession,
  resolveTenant,
  requireTenant,
  scopeToTenant,
} from '../lib/tenant.js';

const SECRET = 'test-session-secret-not-a-real-one';
const OTHER_SECRET = 'a-different-secret-entirely';
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

describe('signSession / verifySession', () => {
  it('round-trips: a signed token verifies back to its tenant', () => {
    const token = signSession(TENANT_A, SECRET, 600);
    assert.equal(typeof token, 'string');
    assert.equal(token.split('.').length, 3);
    assert.deepEqual(verifySession(token, SECRET), { tenantId: TENANT_A });
  });

  it('rejects a tampered payload (tenant swapped after signing)', () => {
    const token = signSession(TENANT_A, SECRET, 600);
    const [header, , sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: TENANT_B, iat: 1, exp: 9999999999 }),
    ).toString('base64url');
    assert.equal(verifySession(`${header}.${forgedPayload}.${sig}`, SECRET), null);
  });

  it('rejects a tampered signature', () => {
    const token = signSession(TENANT_A, SECRET, 600);
    const [header, payload] = token.split('.');
    assert.equal(verifySession(`${header}.${payload}.AAAA`, SECRET), null);
  });

  it('rejects an expired token (hand-built, correctly signed, exp in the past)', () => {
    // signSession will not mint an already-expired token, so build one with
    // the same scheme and the real secret: only the exp can save it, and
    // it must not.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: TENANT_A, iat: 1000, exp: 2000 }),
    ).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
    assert.equal(verifySession(`${header}.${payload}.${sig}`, SECRET), null);
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = signSession(TENANT_A, OTHER_SECRET, 600);
    assert.equal(verifySession(token, SECRET), null);
    const good = signSession(TENANT_A, SECRET, 600);
    assert.equal(verifySession(good, OTHER_SECRET), null);
  });

  it('rejects malformed tokens without throwing', () => {
    assert.equal(verifySession('', SECRET), null);
    assert.equal(verifySession('not-a-token', SECRET), null);
    assert.equal(verifySession(null, SECRET), null);
    assert.equal(verifySession(undefined, SECRET), null);
    assert.equal(verifySession('a.b.c', SECRET), null);
  });
});

describe('resolveTenant / requireTenant', () => {
  it('resolves the tenant from a Bearer header', () => {
    const token = signSession(TENANT_B, SECRET, 600);
    assert.deepEqual(resolveTenant(bearerReq(token), SECRET), { tenantId: TENANT_B });
  });

  it('missing header -> resolveTenant returns null', () => {
    assert.equal(resolveTenant({ headers: {} }, SECRET), null);
    assert.equal(resolveTenant({ headers: { authorization: '' } }, SECRET), null);
    assert.equal(resolveTenant({}, SECRET), null);
    assert.equal(resolveTenant(null, SECRET), null);
  });

  it('non-Bearer header -> null', () => {
    const token = signSession(TENANT_A, SECRET, 600);
    assert.equal(resolveTenant({ headers: { authorization: token } }, SECRET), null);
    assert.equal(
      resolveTenant({ headers: { authorization: `Basic ${token}` } }, SECRET),
      null,
    );
  });

  it('requireTenant returns the tenant and writes nothing on success', () => {
    const token = signSession(TENANT_A, SECRET, 600);
    const res = mockRes();
    assert.deepEqual(requireTenant(bearerReq(token), res, SECRET), { tenantId: TENANT_A });
    assert.equal(res.statusCode, null);
    assert.equal(res.body, null);
  });

  it('requireTenant writes a 401 JSON and returns null when absent/invalid', () => {
    const resMissing = mockRes();
    assert.equal(requireTenant({ headers: {} }, resMissing, SECRET), null);
    assert.equal(resMissing.statusCode, 401);
    assert.deepEqual(resMissing.body, { error: 'Unauthorized' });

    const resBad = mockRes();
    assert.equal(requireTenant(bearerReq('a.b.c'), resBad, SECRET), null);
    assert.equal(resBad.statusCode, 401);
  });
});

describe('scopeToTenant (two-tenant isolation)', () => {
  const rows = [
    { id: 1, tenant_id: TENANT_A, content: 'a-first' },
    { id: 2, tenant_id: TENANT_B, content: 'b-first' },
    { id: 3, tenant_id: TENANT_A, content: 'a-second' },
    { id: 4, tenant_id: TENANT_B, content: 'b-second' },
    { id: 5, tenant_id: TENANT_A, content: 'a-third' },
    { id: 6, tenant_id: null, content: 'unscoped' },
  ];

  it('returns only tenant A rows for tenant A, in order', () => {
    const scoped = scopeToTenant(rows, TENANT_A);
    assert.deepEqual(scoped.map((r) => r.id), [1, 3, 5]);
    assert.ok(scoped.every((r) => r.tenant_id === TENANT_A));
  });

  it('returns only tenant B rows for tenant B — zero leakage either way', () => {
    const scoped = scopeToTenant(rows, TENANT_B);
    assert.deepEqual(scoped.map((r) => r.id), [2, 4]);
    const aIds = new Set(scopeToTenant(rows, TENANT_A).map((r) => r.id));
    assert.ok(scoped.every((r) => !aIds.has(r.id)));
  });

  it('an unknown tenant sees nothing, and bad input yields []', () => {
    assert.deepEqual(
      scopeToTenant(rows, '99999999-9999-4999-8999-999999999999'),
      [],
    );
    assert.deepEqual(scopeToTenant(null, TENANT_A), []);
    assert.deepEqual(scopeToTenant(rows, null), []);
  });
});
