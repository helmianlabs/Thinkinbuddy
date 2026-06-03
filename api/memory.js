// api/memory.js — per-user persistent memory store for ThinkinBuddy.
//
// 2026-06-02: REWRITTEN from Vercel Blob → Neon Postgres + pgvector.
// Spec: jarvis/docs/persistent-memory-spec-2026-05-27.md
//
// HTTP CONTRACT PRESERVED so the ElevenLabs widget's `save_memory` tool keeps
// working without dashboard changes:
//   GET    /api/memory?userId=...                  → { userId, facts: [...] }
//   POST   /api/memory   body { userId, key, value } → { ok, fact }
//   DELETE /api/memory?userId=...&key=...           → { ok }
//
// MAPPING legacy {key, value} → spec {subject, content}:
//   subject ← key (canonical short noun-phrase)
//   content ← value (the durable fact)
//   kind    ← 'fact' (default; extractor handles richer kinds)
//   scope   ← 'semantic'
//
// Embeddings via OpenAI text-embedding-3-small (1536 dims).
// Semantic dedup: skipped for v1 of the rewrite — TODO wire SIM_UPDATE/
// SIM_CONFLICT_LO logic per spec lines 355-468. Current behavior:
//   - Same (user_id, scope='semantic', kind='fact', subject=key) → UPDATE.
//   - Else INSERT new row.
// This keeps the widget contract idempotent on `key` without LLM round-trips.

import { Pool } from 'pg';
import OpenAI from 'openai';

const DB_URL = process.env.DATABASE_URL_MEMORY || process.env.DATABASE_URL;

// Module-scoped pool — reused across warm Lambda invocations.
let _pool = null;
function getPool() {
  if (!_pool) {
    if (!DB_URL) throw new Error('DATABASE_URL_MEMORY (or DATABASE_URL) not set');
    _pool = new Pool({
      connectionString: DB_URL,
      max: 3,
      idleTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pool;
}

let _openai = null;
function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

async function embed(text) {
  const trimmed = String(text || '').slice(0, 8000);
  if (!trimmed) return null;
  const oa = getOpenAI();
  const res = await oa.embeddings.create({
    model: 'text-embedding-3-small',
    input: trimmed,
  });
  return res.data[0].embedding;
}

function vecLiteral(vec) {
  return `[${vec.join(',')}]`;
}

// Shared helpers for other API routes (prime-agent.js, extract-memories.js).
// Keep these exports stable — phase 2 of the Neon migration depends on them.
export { getPool, embed, vecLiteral };

// retrieveMemories: top-N facts for a user, ranked importance DESC then recency.
// v1: no embedding-similarity query — just importance/recency. Returns the same
// [{key, value}] shape buildSystemPrompt expects, plus importance/updatedAt for
// callers that want them.
// TODO: full cosine-distance recall against a query embedding (spec :130-172).
export async function retrieveMemories(userId, limit = 30) {
  if (!userId) return [];
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT subject AS key,
            content AS value,
            importance,
            updated_at
       FROM memory_items
      WHERE user_id = $1
        AND (valid_until IS NULL OR valid_until > now())
        AND supersedes IS NULL
      ORDER BY importance DESC NULLS LAST, updated_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows.map(r => ({
    key: r.key,
    value: r.value,
    importance: r.importance,
    updatedAt: r.updated_at?.toISOString?.() || null,
  }));
}

// upsertExtractedFact: write path for extract-memories.js. Same semantics as the
// HTTP POST /api/memory upsertFact, but allows extractor to set importance and
// source_session. Reuses pool + embed.
export async function upsertExtractedFact({
  userId,
  key,
  value,
  importance = 0.5,
  sourceSession = null,
}) {
  return upsertFactInternal(userId, key, value, { importance, sourceSession });
}

async function upsertFactInternal(userId, key, value, opts = {}) {
  const pool = getPool();
  const subject = String(key).slice(0, 120);
  const content = String(value).slice(0, 500);
  const importance = typeof opts.importance === 'number' ? opts.importance : 0.5;
  const sourceSession = opts.sourceSession || null;

  const existing = await pool.query(
    `SELECT id FROM memory_items
      WHERE user_id = $1 AND scope = 'semantic' AND kind = 'fact'
        AND subject = $2 AND supersedes IS NULL
      LIMIT 1`,
    [userId, subject]
  );

  let vec = null;
  try { vec = await embed(`${subject}: ${content}`); }
  catch (e) { console.error('[memory] embed failed:', e?.message || e); }

  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    if (vec) {
      await pool.query(
        `UPDATE memory_items
            SET content = $1, embedding = $2::vector, importance = $3
          WHERE id = $4`,
        [content, vecLiteral(vec), importance, id]
      );
    } else {
      await pool.query(
        `UPDATE memory_items SET content = $1, importance = $2 WHERE id = $3`,
        [content, importance, id]
      );
    }
    return { id, subject, content, action: 'updated' };
  }

  const insert = await pool.query(
    `INSERT INTO memory_items
       (user_id, scope, kind, subject, content, embedding, confidence, importance, source_session)
     VALUES ($1, 'semantic', 'fact', $2, $3, ${vec ? '$4::vector' : 'NULL'}, 0.7, ${vec ? '$5' : '$4'}, ${vec ? '$6' : '$5'})
     RETURNING id`,
    vec ? [userId, subject, content, vecLiteral(vec), importance, sourceSession]
        : [userId, subject, content, importance, sourceSession]
  );
  return { id: insert.rows[0].id, subject, content, action: 'inserted' };
}

async function readFacts(userId) {
  const pool = getPool();
  const sql = `
    SELECT id, subject AS key, content AS value, updated_at, created_at, importance, confidence
      FROM memory_items
     WHERE user_id = $1
       AND scope = 'semantic'
       AND supersedes IS NULL
       AND (valid_until IS NULL OR valid_until > now())
     ORDER BY importance DESC, confidence DESC, updated_at DESC
  `;
  const { rows } = await pool.query(sql, [userId]);
  return rows.map(r => ({
    key: r.key,
    value: r.value,
    savedAt: (r.updated_at || r.created_at)?.toISOString?.() || null,
  }));
}

async function upsertFact(userId, key, value) {
  const pool = getPool();
  const subject = String(key).slice(0, 120);
  const content = String(value).slice(0, 500);

  // Try UPDATE-by-subject first (idempotent on legacy {key,value} writes).
  // Embedding refresh is fire-and-forget on UPDATE to keep the path fast.
  const existing = await pool.query(
    `SELECT id FROM memory_items
      WHERE user_id = $1 AND scope = 'semantic' AND kind = 'fact'
        AND subject = $2 AND supersedes IS NULL
      LIMIT 1`,
    [userId, subject]
  );

  let vec = null;
  try { vec = await embed(`${subject}: ${content}`); }
  catch (e) { console.error('[memory] embed failed:', e?.message || e); }

  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    if (vec) {
      await pool.query(
        `UPDATE memory_items
            SET content = $1, embedding = $2::vector
          WHERE id = $3`,
        [content, vecLiteral(vec), id]
      );
    } else {
      await pool.query(
        `UPDATE memory_items SET content = $1 WHERE id = $2`,
        [content, id]
      );
    }
    return { id, subject, content, action: 'updated' };
  }

  const insert = await pool.query(
    `INSERT INTO memory_items
       (user_id, scope, kind, subject, content, embedding, confidence, importance)
     VALUES ($1, 'semantic', 'fact', $2, $3, ${vec ? '$4::vector' : 'NULL'}, 0.7, 0.5)
     RETURNING id`,
    vec ? [userId, subject, content, vecLiteral(vec)]
        : [userId, subject, content]
  );
  return { id: insert.rows[0].id, subject, content, action: 'inserted' };
}

async function deleteFact(userId, key) {
  const pool = getPool();
  const subject = String(key).slice(0, 120);
  const r = await pool.query(
    `DELETE FROM memory_items
      WHERE user_id = $1 AND scope = 'semantic' AND subject = $2`,
    [userId, subject]
  );
  return { deleted: r.rowCount };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!DB_URL) {
    return res.status(500).json({ error: 'memory store not configured (DATABASE_URL_MEMORY missing)' });
  }

  try {
    if (req.method === 'GET') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required' });
      const facts = await readFacts(userId);
      return res.status(200).json({ userId, facts });
    }

    if (req.method === 'POST') {
      const { key, value } = req.body || {};
      const userId = req.body?.userId || req.query?.userId;
      if (!userId) return res.status(400).json({ error: 'userId required' });
      if (!key || !value) return res.status(400).json({ error: 'key and value required' });
      const out = await upsertFact(userId, key, value);
      return res.status(200).json({
        ok: true,
        fact: { key: out.subject, value: out.content, savedAt: new Date().toISOString() },
        action: out.action,
      });
    }

    if (req.method === 'DELETE') {
      const { userId, key } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId required' });
      if (!key) return res.status(400).json({ error: 'key required' });
      await deleteFact(userId, key);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[memory] handler error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'memory op failed' });
  }
}
