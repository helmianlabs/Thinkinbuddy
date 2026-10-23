// test/session-identity.test.mjs — buddy-repair bite: the three stacked
// breaks that left Troy's buddy running the agent's default prompt with
// no memories on the store preview (live trace, 2026-10-23):
//
//   BREAK 1 (client): index.html's prime call and the apiFetch wrapper
//   never sent the session token, so prime-agent's requireTenant 401'd
//   in hosted mode and no sessionPromptOverride ever reached the
//   widget. Fix: tbSessionToken/tbAuthHeaders helpers attach
//   `Authorization: Bearer <tb_token>` (the exact localStorage key
//   public/onboarding.js writes) to the prime fetch and inside apiFetch
//   for same-origin /api calls — only when a token exists.
//
//   BREAK 2 (server): prime-agent resolved userId = tenantId and
//   memory.js retrieveMemories filtered `user_id = $1 AND tenant_id =
//   $n`. Troy's claimed rows carry user_id 'troy' under his tenant, so
//   his memory section came back empty. Fix: in enforced mode memory
//   belongs to the TENANT — tenant_id is the only identity filter in
//   retrieval (and the dedup/read/delete paths mirror it); writes
//   stamp the tenant identity. Compat mode keeps user_id filtering
//   byte-for-byte.
//
//   BREAK 3 (client+server): the in-call identity stayed the string
//   'troy', which resolveHandlerTenant rejects in enforced mode, so
//   conversation-turn capture failed closed. Fix: the client sends the
//   session token on the capture/extract fetches and carries the
//   tenant id (tb_tenant) as the in-call user identity when logged in;
//   conversation-turn stamps the resolved tenant identity on the
//   session row even when the body still says 'troy'.
//
// DB: no live database. pg's Pool.prototype.query is replaced with a
// small emulator that applies the identity predicate the SQL actually
// carries (user_id = $n XOR tenant_id = $n) over seeded rows — so the
// pre-fix dual filter genuinely fails these tests and the tenant-only
// filter genuinely passes. Env is set BEFORE the handler imports
// (memory.js reads DATABASE_URL at module load); SESSION_SECRET is
// toggled per-test for the compat cases and always restored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SECRET = 'session-identity-test-secret';
const TROY_TENANT = '02070cfa-1e7c-4dc1-9bd9-31d9f9d5dcaf6';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

process.env.SESSION_SECRET = SECRET;
delete process.env.DATABASE_URL_MEMORY;
process.env.DATABASE_URL = 'postgres://fake:fake@localhost:5432/fake';

const { Pool } = await import('pg');
const { signSession } = await import('../lib/tenant.js');

// ─── Fake Postgres ───────────────────────────────────────────────────
// Seeded memory_items. The composition is the whole point:
//   - three rows tagged user_id 'troy' under Troy's tenant (his
//     claimed single-user-era history),
//   - one row tagged with the tenant id itself under Troy's tenant
//     (a post-fix write),
//   - one 'troy'-tagged row under ANOTHER tenant (the tenant boundary
//     must exclude it in enforced mode; compat mode, keyed on user_id
//     alone, includes it — that difference pins both semantics),
//   - one stranger row under the other tenant.
const seedRows = [
  { user_id: 'troy', tenant_id: TROY_TENANT, scope: 'semantic', subject: 'dog', content: 'MARKER_DOG', importance: 0.9, confidence: 0.9, valid_until: null, updated_at: new Date('2026-10-03') },
  { user_id: 'troy', tenant_id: TROY_TENANT, scope: 'semantic', subject: 'job', content: 'MARKER_JOB', importance: 0.8, confidence: 0.8, valid_until: null, updated_at: new Date('2026-10-02') },
  { user_id: 'troy', tenant_id: TROY_TENANT, scope: 'semantic', subject: 'spanish', content: 'MARKER_SPANISH', importance: 0.7, confidence: 0.7, valid_until: null, updated_at: new Date('2026-10-01') },
  { user_id: TROY_TENANT, tenant_id: TROY_TENANT, scope: 'semantic', subject: 'self', content: 'MARKER_TENANT_SELF', importance: 0.6, confidence: 0.6, valid_until: null, updated_at: new Date('2026-09-30') },
  { user_id: 'troy', tenant_id: OTHER_TENANT, scope: 'semantic', subject: 'alien', content: 'MARKER_OTHER_TENANT_TROY', importance: 0.95, confidence: 0.95, valid_until: null, updated_at: new Date('2026-10-04') },
  { user_id: 'someone', tenant_id: OTHER_TENANT, scope: 'semantic', subject: 'stranger', content: 'MARKER_STRANGER', importance: 0.99, confidence: 0.99, valid_until: null, updated_at: new Date('2026-10-05') },
];

const recorded = []; // non-SELECT statements, in order: { sql, params }

function fakeQuery(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (/FROM memory_items/i.test(s)) {
    let rows = [...seedRows];
    const idm = s.match(/(user_id|tenant_id) = \$(\d+)/);
    assert.ok(idm, `memory SELECT must carry exactly one identity predicate: ${s}`);
    const col = idm[1];
    const val = params[Number(idm[2]) - 1];
    rows = rows.filter((r) => r[col] === val);
    const scopeM = s.match(/scope = ANY\(\$(\d+)::text\[\]\)/);
    if (scopeM) {
      const scopes = params[Number(scopeM[1]) - 1];
      rows = rows.filter((r) => scopes.includes(r.scope));
    }
    rows = rows.filter((r) => r.valid_until == null);
    rows.sort((a, b) =>
      (b.importance - a.importance) || (b.confidence - a.confidence) || (b.updated_at - a.updated_at));
    const limM = s.match(/LIMIT \$(\d+)/);
    if (limM) rows = rows.slice(0, params[Number(limM[1]) - 1]);
    return Promise.resolve({
      rows: rows.map((r) => ({ key: r.subject, value: r.content, importance: r.importance, updated_at: r.updated_at })),
      rowCount: rows.length,
    });
  }
  if (/conversation_(sessions|turns)/i.test(s) || /^UPDATE conversation_sessions/i.test(s)) {
    recorded.push({ sql: s, params: [...params] });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  throw new Error(`session-identity fake: unhandled SQL: ${s.slice(0, 140)}`);
}

Pool.prototype.query = function patchedQuery(sql, params) {
  return fakeQuery(sql, params);
};

const primeHandler = (await import('../server/handlers/prime-agent.js')).default;
const turnHandler = (await import('../server/handlers/conversation-turn.js')).default;

function mockRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function bearerReq(token, body) {
  return { method: 'POST', headers: { authorization: `Bearer ${token}` }, body };
}

// ─── (b) BREAK 2 — prime with a token finds tenant-keyed memories ────

test('prime-agent (enforced): token + legacy-tagged rows -> prompt carries the memories', async () => {
  const token = signSession(TROY_TENANT, SECRET, 600);
  const res = mockRes();
  await primeHandler(bearerReq(token, { userId: 'troy', userName: 'Troy', buddyName: 'ThinkinBuddy' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tenantId, TROY_TENANT);
  // All four of the tenant's rows — the three user_id 'troy' rows AND
  // the tenant-tagged one. The pre-fix dual filter returned 0 here.
  assert.equal(res.body.memoryCount, 4);
  assert.ok(res.body.prompt.includes('[WHAT YOU KNOW'), 'prompt has the memory section');
  for (const marker of ['MARKER_DOG', 'MARKER_JOB', 'MARKER_SPANISH', 'MARKER_TENANT_SELF']) {
    assert.ok(res.body.prompt.includes(marker), `prompt includes ${marker}`);
  }
  // The tenant boundary holds both ways it could leak.
  assert.ok(!res.body.prompt.includes('MARKER_OTHER_TENANT_TROY'), 'no cross-tenant troy-tagged row');
  assert.ok(!res.body.prompt.includes('MARKER_STRANGER'), 'no stranger row');
});

test('prime-agent (enforced): no token -> 401, the break-1 server half', async () => {
  const res = mockRes();
  await primeHandler({ method: 'POST', headers: {}, body: { userId: 'troy' } }, res);
  assert.equal(res.statusCode, 401);
});

test('prime-agent (compat): no SESSION_SECRET -> user_id semantics, unchanged', async () => {
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const res = mockRes();
    await primeHandler({ method: 'POST', headers: {}, body: { userId: 'troy', userName: 'Troy' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    // user_id 'troy' is the ONLY identity in compat mode: the four
    // troy-tagged rows (including the one stamped with another tenant —
    // compat has no tenants), and NOT the tenant-tagged row.
    assert.equal(res.body.memoryCount, 4);
    assert.ok(res.body.prompt.includes('MARKER_OTHER_TENANT_TROY'));
    assert.ok(!res.body.prompt.includes('MARKER_TENANT_SELF'));
    assert.ok(!res.body.prompt.includes('MARKER_STRANGER'));
    assert.equal(res.body.tenantId, null);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

// ─── (c) BREAK 3 — conversation-turn under a login ───────────────────

test('conversation-turn (enforced): token + body userId "troy" accepted, stamps tenant identity', async () => {
  recorded.length = 0;
  const token = signSession(TROY_TENANT, SECRET, 600);
  const res = mockRes();
  await turnHandler(bearerReq(token, {
    sessionId: SESSION_ID, userId: 'troy', turnIndex: 0, role: 'user', content: 'hello',
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  const sessionInsert = recorded.find((q) => /INSERT INTO conversation_sessions/i.test(q.sql));
  assert.ok(sessionInsert, 'session insert recorded');
  assert.ok(sessionInsert.sql.includes('tenant_id'), 'enforced insert carries the tenant column');
  assert.equal(sessionInsert.params[0], SESSION_ID);
  assert.equal(sessionInsert.params[1], TROY_TENANT, 'session user_id stamped with the tenant identity, not "troy"');
  assert.equal(sessionInsert.params[4], TROY_TENANT, 'session tenant_id stamped');

  const turnInsert = recorded.find((q) => /INSERT INTO conversation_turns/i.test(q.sql));
  assert.ok(turnInsert, 'turn insert recorded');
  assert.equal(turnInsert.params[5], TROY_TENANT, 'turn tenant_id stamped');
});

test('conversation-turn (enforced): no token + non-UUID userId is still rejected', async () => {
  recorded.length = 0;
  const res = mockRes();
  await turnHandler({ method: 'POST', headers: {}, body: {
    sessionId: SESSION_ID, userId: 'troy', turnIndex: 0, role: 'user', content: 'hello',
  } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(recorded.length, 0, 'nothing was written');
});

test('conversation-turn (compat): no SESSION_SECRET -> original inserts, userId as passed', async () => {
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    recorded.length = 0;
    const res = mockRes();
    await turnHandler({ method: 'POST', headers: {}, body: {
      sessionId: SESSION_ID, userId: 'troy', turnIndex: 0, role: 'user', content: 'hello',
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    const sessionInsert = recorded.find((q) => /INSERT INTO conversation_sessions/i.test(q.sql));
    assert.ok(sessionInsert);
    assert.ok(!sessionInsert.sql.includes('tenant_id'), 'compat insert has no tenant column at all');
    assert.equal(sessionInsert.params[1], 'troy', 'compat stamps the caller userId unchanged');
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

// ─── (a) BREAK 1 — the client attaches the session ───────────────────

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const a = indexHtml.indexOf(startMarker);
  assert.ok(a >= 0, `marker not found: ${startMarker}`);
  const b = indexHtml.indexOf(endMarker, a);
  assert.ok(b > a, `end marker not found after: ${startMarker}`);
  return indexHtml.slice(a, b + endMarker.length);
}

test('client helpers + apiFetch: Authorization rides only when a token exists', () => {
  const helpersSrc = sliceBetween('function tbSessionToken', '// Poll for newly generated images');
  const apiFetchSrc = sliceBetween('const TEXT_BRAIN_KEYS', 'window.thinkinBuddyApiFetch = apiFetch;');

  const store = new Map();
  const fetches = [];
  const sandbox = {
    console,
    currentUser: { userId: 'troy' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    loadKeys: () => ({}),
    loadBrain: () => 'auto',
    loadBrainModel: () => null,
    fetch: (url, opts) => { fetches.push({ url, opts }); return Promise.resolve({}); },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(helpersSrc, sandbox);
  vm.runInNewContext(apiFetchSrc, sandbox);

  // Logged in: token + tenant present (the keys onboarding.js writes).
  // (Property-wise compares: vm-realm objects fail deepStrictEqual on
  // prototype identity alone.)
  store.set('tb_token', 'tok-abc');
  store.set('tb_tenant', TROY_TENANT);
  assert.equal(sandbox.tbAuthHeaders().Authorization, 'Bearer tok-abc');
  assert.deepEqual(Object.keys(sandbox.tbAuthHeaders()), ['Authorization']);
  assert.equal(sandbox.tbSessionTenantId(), TROY_TENANT);
  assert.equal(sandbox.tbCallUserId(), TROY_TENANT, 'in-call identity is the tenant id when logged in');

  fetches.length = 0;
  sandbox.apiFetch('/api/chat', { method: 'POST' });
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].opts.headers.Authorization, 'Bearer tok-abc', 'apiFetch attaches the session');

  // Cross-origin gets nothing, token or not (unchanged apiFetch rule 1).
  fetches.length = 0;
  sandbox.apiFetch('https://example.invalid/x', { method: 'POST' });
  assert.equal(fetches[0].opts.headers, undefined, 'no headers are attached cross-origin');

  // Signed out / legacy: no token stored -> no header, no tenant, and
  // the in-call identity falls back to the legacy user id.
  store.clear();
  assert.deepEqual(Object.keys(sandbox.tbAuthHeaders()), []);
  assert.equal(sandbox.tbCallUserId(), 'troy');
  fetches.length = 0;
  sandbox.apiFetch('/api/chat', { method: 'POST' });
  assert.ok(!('Authorization' in (fetches[0].opts.headers || {})), 'no Authorization header without a token');
});

test('client call sites: prime, turn capture, extract, and the widget identity use the session', () => {
  // The helpers read the exact storage keys public/onboarding.js writes.
  assert.ok(indexHtml.includes("localStorage.getItem('tb_token')"));
  assert.ok(indexHtml.includes("localStorage.getItem('tb_tenant')"));

  const prime = sliceBetween("fetch('/api/prime-agent'", 'const p = await primeRes.json();');
  assert.ok(prime.includes('tbAuthHeaders()'), 'prime fetch sends the session token');

  const turn = sliceBetween("fetch('/api/conversation-turn'", 'keepalive: true,');
  assert.ok(turn.includes('tbAuthHeaders()'), 'turn capture sends the session token');
  assert.ok(turn.includes('tbCallUserId()'), 'turn capture carries the tenant identity');

  const extract = sliceBetween("fetch('/api/extract-memories'", 'keepalive: true,');
  assert.ok(extract.includes('tbAuthHeaders()'), 'extract-memories sends the session token');
  assert.ok(extract.includes('tbCallUserId()'), 'extract-memories carries the tenant identity');

  assert.ok(indexHtml.includes('let uid = tbCallUserId();'), 'widget user_id dynamic variable prefers the tenant identity');
  assert.ok(indexHtml.includes('user_id: uid'), 'widget still always sends a user_id dynamic variable');
});
