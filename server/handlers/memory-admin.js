// api/memory-admin.js — user-facing CRUD + export + audit for memory_items.
//
// Spec: docs/persistent-memory-spec-2026-05-27.md (lines 503-558).
//
// This is the human review surface for a user's persistent memory: list/filter,
// edit a field, hard-delete, export the whole store as JSON, and walk the
// supersedes chain to see how a single fact evolved.
//
// ─── ROUTES (all keyed off ?userId=, + an `action` query param) ──────────────
//   GET    /api/memory-admin?userId=U
//            [&scope=..&kind=..&limit=50&offset=0]      → paginated list
//   GET    /api/memory-admin?userId=U&id=ID            → single row
//   GET    /api/memory-admin?userId=U&action=export    → full JSON dump
//                                                         (Content-Disposition)
//   GET    /api/memory-admin?userId=U&id=ID&action=audit → supersedes chain
//   PATCH  /api/memory-admin?userId=U&id=ID
//            body { subject?, content?, importance?, valid_until? }  → edit
//   DELETE /api/memory-admin?userId=U&id=ID            → hard delete
//
// Column reference (scripts/setup-memory-db.mjs:50-67):
//   id UUID, user_id TEXT, scope TEXT, kind TEXT, subject TEXT, content TEXT,
//   embedding VECTOR(1536), confidence REAL, importance REAL,
//   valid_until TIMESTAMPTZ, supersedes UUID, source_session TEXT,
//   source_span INT4RANGE, blob_url TEXT, created_at, updated_at.
//
// ─── AUTH ────────────────────────────────────────────────────────────────────
// Two gates, both applied in the handler below:
//   1. requireWebhookSecret — the shared operator secret this endpoint
//      has always required (closed by default when WEBHOOK_SECRET is
//      unset).
//   2. Tenant session (ENFORCED mode only — SESSION_SECRET set, the
//      hosted store build): resolveScopedRequestIdentity requires a
//      valid session token and replaces the query-string userId with
//      the session's tenant; every query below then ALSO filters on
//      tenant_id, so a caller can only ever reach their own tenant's
//      rows. In compat mode (no SESSION_SECRET — today's live
//      single-user deployment) behavior is exactly the pre-wiring
//      behavior: userId from the query string, user_id-only queries.

import { getPool } from './memory.js';
import { applyBrowserCors, requireWebhookSecret } from '../../lib/security.js';
import { resolveScopedRequestIdentity } from '../../lib/tenant.js';

// Columns safe to return to the client (everything except the raw embedding,
// which is large and useless to a human reviewer).
const SELECT_COLS = `
  id, user_id, scope, kind, subject, content,
  confidence, importance, valid_until, supersedes,
  source_session, source_span, blob_url, created_at, updated_at
`;

function toIso(v) {
  return v?.toISOString?.() || v || null;
}

// Normalize a DB row's timestamp-ish fields to ISO strings for JSON.
function shapeRow(r) {
  if (!r) return r;
  return {
    ...r,
    valid_until: toIso(r.valid_until),
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

export default async function handler(req, res) {
  const corsOk = applyBrowserCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // applyBrowserCors locks methods to "POST, GET, OPTIONS"; widen for PATCH/DELETE
  // so browser preflight for those verbs succeeds from an allowed origin.
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');

  // Block disallowed browser origins (server-to-server callers with no Origin
  // header pass corsOk=false too — for those, the AUTH TODO above is the real
  // gate, not CORS — so only reject when an Origin header was actually present
  // and not allowed).
  const origin = req.headers?.origin || '';
  if (origin && !corsOk) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // ─── AUTH ─────────────────────────────────────────────────────────────
  // CORS is NOT authentication (see lib/security.js header): a non-browser
  // client sends no Origin at all and sails past the check above. The
  // webhook secret is the first gate; in enforced (hosted) mode the
  // tenant session is the second, and it — not the query string — names
  // whose memories these are.
  if (!requireWebhookSecret(req, res)) return;

  const scoped = resolveScopedRequestIdentity(req, res, req.query?.userId);
  if (!scoped.ok) return; // enforced mode: requireTenant wrote the 401
  const userId = scoped.userId;
  const tenantId = scoped.tenantId; // null in compat mode -> original queries
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const id = req.query?.id;
  const action = req.query?.action;

  try {
    const pool = getPool();

    // ─── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (action === 'export') return exportDump(pool, userId, res, tenantId);
      if (action === 'audit') {
        if (!id) return res.status(400).json({ error: 'id required for audit' });
        return auditChain(pool, userId, id, res, tenantId);
      }
      if (id) return getOne(pool, userId, id, res, tenantId);
      return listMemories(pool, userId, req, res, tenantId);
    }

    // ─── PATCH ────────────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'id required' });
      return patchOne(pool, userId, id, req, res, tenantId);
    }

    // ─── DELETE ───────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id required' });
      return deleteOne(pool, userId, id, res, tenantId);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[memory-admin] error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'admin op failed' });
  }
}

// GET list — filter by scope/kind, paginate. Newest/most-important first.
// tenantId (enforced mode only) adds the tenant_id filter to BOTH the
// page query and the count query; null (compat) leaves them untouched.
async function listMemories(pool, userId, req, res, tenantId = null) {
  const { scope, kind } = req.query;
  // Clamp pagination to sane bounds.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  // Build WHERE dynamically; $1 is always userId.
  const where = ['user_id = $1'];
  const params = [userId];
  if (tenantId) { params.push(tenantId); where.push(`tenant_id = $${params.length}`); }
  if (scope) { params.push(scope); where.push(`scope = $${params.length}`); }
  if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }

  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  params.push(limit, offset);

  const sql = `
    SELECT ${SELECT_COLS}
      FROM memory_items
     WHERE ${where.join(' AND ')}
     ORDER BY importance DESC NULLS LAST, created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const { rows } = await pool.query(sql, params);

  // Total (unpaginated) count for the same filter, for pager UIs.
  const countParams = params.slice(0, params.length - 2); // drop limit+offset
  const { rows: cnt } = await pool.query(
    `SELECT count(*)::int AS total FROM memory_items WHERE ${where.join(' AND ')}`,
    countParams
  );

  return res.status(200).json({
    userId,
    total: cnt[0]?.total ?? 0,
    limit,
    offset,
    items: rows.map(shapeRow),
  });
}

// GET single row by id (scoped to user, and to tenant in enforced mode).
async function getOne(pool, userId, id, res, tenantId = null) {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS} FROM memory_items WHERE id = $1 AND user_id = $2${tenantId ? ' AND tenant_id = $3' : ''}`,
    tenantId ? [id, userId, tenantId] : [id, userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ item: shapeRow(rows[0]) });
}

// GET export — full JSON dump for the user, with a download header.
async function exportDump(pool, userId, res, tenantId = null) {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS}
       FROM memory_items
      WHERE user_id = $1${tenantId ? ' AND tenant_id = $2' : ''}
      ORDER BY created_at`,
    tenantId ? [userId, tenantId] : [userId]
  );
  // Sanitize userId for a header-safe filename.
  const safeUser = String(userId).replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="memory-${safeUser}-${Date.now()}.json"`
  );
  return res.status(200).json({
    exported_at: new Date().toISOString(),
    userId,
    count: rows.length,
    items: rows.map(shapeRow),
  });
}

// GET audit — walk the supersedes chain backwards from `id`, showing the
// history of one fact. Guards against cycles with a seen-set and a hard cap.
async function auditChain(pool, userId, id, res, tenantId = null) {
  const chain = [];
  const seen = new Set();
  let cursor = id;
  const MAX_HOPS = 100; // defensive: never loop forever on a corrupt chain
  for (let hops = 0; cursor && hops < MAX_HOPS; hops++) {
    if (seen.has(cursor)) break; // cycle guard
    seen.add(cursor);
    const { rows } = await pool.query(
      `SELECT id, scope, kind, subject, content, importance,
              source_session, source_span, supersedes,
              created_at, updated_at, valid_until
         FROM memory_items
        WHERE id = $1 AND user_id = $2${tenantId ? ' AND tenant_id = $3' : ''}`,
      tenantId ? [cursor, userId, tenantId] : [cursor, userId]
    );
    if (!rows.length) break;
    chain.push(shapeRow(rows[0]));
    cursor = rows[0].supersedes;
  }
  if (!chain.length) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ userId, rootId: id, depth: chain.length, chain });
}

// PATCH — edit subject/content/importance/valid_until by id.
async function patchOne(pool, userId, id, req, res, tenantId = null) {
  const body = req.body || {};
  const sets = [];
  const params = [];

  if (typeof body.subject === 'string') {
    params.push(body.subject.slice(0, 120));
    sets.push(`subject = $${params.length}`);
  }
  if (typeof body.content === 'string') {
    params.push(body.content.slice(0, 500));
    sets.push(`content = $${params.length}`);
  }
  if (body.importance !== undefined && body.importance !== null) {
    const imp = Number(body.importance);
    if (!Number.isFinite(imp) || imp < 0 || imp > 1) {
      return res.status(400).json({ error: 'importance must be a number in [0,1]' });
    }
    params.push(imp);
    sets.push(`importance = $${params.length}`);
  }
  if (body.valid_until !== undefined) {
    // Allow null (clear the expiry) or an ISO/timestamp string.
    if (body.valid_until === null) {
      sets.push(`valid_until = NULL`);
    } else {
      const d = new Date(body.valid_until);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'valid_until must be null or a valid date' });
      }
      params.push(d.toISOString());
      sets.push(`valid_until = $${params.length}::timestamptz`);
    }
  }

  if (!sets.length) {
    return res.status(400).json({ error: 'no editable fields provided (subject, content, importance, valid_until)' });
  }

  // updated_at is maintained by the trg_memory_touch trigger
  // (scripts/setup-memory-db.mjs:83-90), so we don't set it here.
  params.push(id, userId);
  const idIdx = params.length - 1;
  const userIdx = params.length;
  let tenantClause = '';
  if (tenantId) {
    params.push(tenantId);
    tenantClause = ` AND tenant_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `UPDATE memory_items
        SET ${sets.join(', ')}
      WHERE id = $${idIdx} AND user_id = $${userIdx}${tenantClause}
      RETURNING ${SELECT_COLS}`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true, item: shapeRow(rows[0]) });
}

// DELETE — hard delete by id. supersedes FK is ON DELETE SET NULL
// (scripts/setup-memory-db.mjs:61), so dependents are not cascaded.
async function deleteOne(pool, userId, id, res, tenantId = null) {
  const { rowCount } = await pool.query(
    `DELETE FROM memory_items WHERE id = $1 AND user_id = $2${tenantId ? ' AND tenant_id = $3' : ''}`,
    tenantId ? [id, userId, tenantId] : [id, userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true, deleted: rowCount });
}
