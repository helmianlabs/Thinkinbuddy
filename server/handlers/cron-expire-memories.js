// api/cron-expire-memories.js — scheduled hard-delete of expired memory rows.
//
// Spec: docs/persistent-memory-spec-2026-05-27.md (valid_until lifecycle).
//
// WHAT IT DOES
//   Hard-deletes memory_items whose valid_until passed more than GRACE_DAYS ago.
//   A grace window (7 days) keeps a just-expired fact around briefly so a
//   resurrecting/correcting write can still reference it via supersedes before
//   it vanishes. Rows with valid_until IS NULL (durable facts) are NEVER touched.
//
//   memory_items.supersedes is `UUID REFERENCES memory_items(id) ON DELETE SET NULL`
//   (scripts/setup-memory-db.mjs:61), so deleting an expired row does NOT cascade —
//   any newer row that superseded it simply has its supersedes pointer nulled.
//
// AUTH
//   Vercel Cron invokes GET with header `Authorization: Bearer <CRON_SECRET>`
//   (when CRON_SECRET is set as a project env var, Vercel sends it automatically).
//   We also accept `x-cron-secret: <CRON_SECRET>` for manual/curl invocation.
//   Closed-by-default: if CRON_SECRET is unset the endpoint refuses to run.
//
// SCHEDULE
//   Registered in vercel.json "crons" → path "/api/cron-expire-memories",
//   schedule "0 7 * * *" (daily 07:00 UTC).

import { getPool } from './memory.js';

const GRACE_DAYS = 7;

// Closed-by-default secret check. Returns true iff the caller proved it holds
// CRON_SECRET. Writes the 401/503 response itself and returns false otherwise.
function authorized(req, res) {
  const expected = process.env.CRON_SECRET || '';
  if (!expected) {
    res.status(503).json({ error: 'Server not configured: CRON_SECRET missing' });
    return false;
  }
  const authHeader = req.headers?.['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : '';
  const provided = bearer || req.headers?.['x-cron-secret'] || '';

  // Length-checked constant-ish-time compare (mirrors lib/security.js style).
  if (provided.length !== expected.length) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (diff !== 0) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  // Cron fires GET; allow GET/POST so the job can be triggered either way.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!authorized(req, res)) return; // response already written

  try {
    const pool = getPool();
    // Grace window: only delete rows whose valid_until is older than now()-7d.
    // Parameterize the interval to keep GRACE_DAYS the single source of truth.
    const { rowCount } = await pool.query(
      `DELETE FROM memory_items
        WHERE valid_until IS NOT NULL
          AND valid_until < now() - ($1::int * interval '1 day')`,
      [GRACE_DAYS]
    );
    return res.status(200).json({
      ok: true,
      deleted: rowCount,
      graceDays: GRACE_DAYS,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[cron-expire-memories] error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'expire op failed' });
  }
}
