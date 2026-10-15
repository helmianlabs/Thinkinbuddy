// api/memory.js — per-user persistent memory store for ThinkinBuddy.
//
// 2026-06-02: REWRITTEN from Vercel Blob → Neon Postgres + pgvector.
// Spec: thinkinbuddy/docs/persistent-memory-spec-2026-05-27.md
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

// retrieveMemories: top-N facts for a user.
//
// TWO PATHS, one function (spec :130-172 retrieveMemories + :476-498 bootSession):
//   - WITH a query  → VECTOR-FIRST recall. Embed the query, ORDER BY cosine
//                     distance (embedding <=> vec), tiebreak importance DESC,
//                     confidence DESC, created_at DESC. Mirrors
//                     lib/mediaMemory.js:94-116. Rows with no embedding sort last
//                     (NULL distance) but are still eligible.
//   - NO query (boot) → importance DESC, confidence DESC, updated_at DESC. This is
//                     the non-circular boot path the spec describes (:471-498):
//                     on page load there is no "what are they talking about" hook
//                     yet, so we pull the highest-value rows.
//
// SCOPES (spec :141-143): default ['semantic']. Callers may pass
// ['semantic','project:<slug>','task:<id>'] to widen recall. Filtered with
// scope = ANY($scopes::text[]).
//
// RETURN SHAPE is preserved: [{key, value, importance, updatedAt}]. buildSystemPrompt
// (lib/personality.js:92) reads m.value; prime-agent.js reads facts.length. Extra
// fields are additive and harmless.
//
// Signature stays backward-compatible: retrieveMemories(userId, limit) still works
// exactly as before (no query → boot path, default semantic scope). New callers
// pass an options object: retrieveMemories(userId, { limit, query, scopes }).
export async function retrieveMemories(userId, optsOrLimit = 30) {
  if (!userId) return [];

  // Back-compat: a bare number means "limit, no query, default scope".
  const opts = typeof optsOrLimit === 'number'
    ? { limit: optsOrLimit }
    : (optsOrLimit || {});
  const limit = typeof opts.limit === 'number' ? opts.limit : 30;
  const query = typeof opts.query === 'string' ? opts.query.trim() : '';
  const scopes = Array.isArray(opts.scopes) && opts.scopes.length > 0
    ? opts.scopes
    : ['semantic'];

  const pool = getPool();

  // VECTOR-FIRST path: embed the query and rank by cosine distance.
  if (query) {
    let vec = null;
    try { vec = await embed(query); }
    catch (e) { console.error('[memory] retrieve embed failed (falling back to boot rank):', e?.message || e); }

    if (vec) {
      const { rows } = await pool.query(
        `SELECT subject AS key,
                content AS value,
                importance,
                updated_at
           FROM memory_items
          WHERE user_id = $1
            AND scope = ANY($2::text[])
            AND (valid_until IS NULL OR valid_until > now())
            -- liveness gated by valid_until; supersedes is an audit back-pointer, not a hide flag
          ORDER BY embedding <=> $3::vector,
                   importance DESC NULLS LAST,
                   confidence DESC NULLS LAST,
                   created_at DESC
          LIMIT $4`,
        [userId, scopes, vecLiteral(vec), limit]
      );
      return rows.map(r => ({
        key: r.key,
        value: r.value,
        importance: r.importance,
        updatedAt: r.updated_at?.toISOString?.() || null,
      }));
    }
    // Embedding failed → fall through to boot rank rather than erroring.
  }

  // BOOT path (no query, or embed failed): importance/confidence/recency.
  const { rows } = await pool.query(
    `SELECT subject AS key,
            content AS value,
            importance,
            updated_at
       FROM memory_items
      WHERE user_id = $1
        AND scope = ANY($2::text[])
        AND (valid_until IS NULL OR valid_until > now())
      ORDER BY importance DESC NULLS LAST,
               confidence DESC NULLS LAST,
               updated_at DESC
      LIMIT $3`,
    [userId, scopes, limit]
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

// ---------------------------------------------------------------------------
// Semantic dedup + supersedes wiring (spec :351-468).
//
// saveMemoryCandidates() replaces the shallow kind+subject dedup (upsertFact)
// with embedding nearest-neighbor logic and finally wires the supersedes column:
//   - topSim >= SIM_UPDATE (0.92)      → MERGE into the nearest row (GREATEST
//                                        confidence/importance, replace content).
//   - SIM_CONFLICT_LO (0.75) <= topSim → ask the LLM if the new statement
//        < SIM_UPDATE                    contradicts the old one. If 'contradicts':
//                                        BEGIN; UPDATE old SET valid_until=now();
//                                        INSERT new WITH supersedes=old.id; COMMIT.
//   - otherwise                        → fresh INSERT.
//
// `llm` is (system, user) => Promise<string> per spec :364. If omitted, a default
// is built from ANTHROPIC_API_KEY using the same raw-fetch call shape as
// api/extract-memories.js:54-74 (model claude-haiku-4-5, version 2023-06-01).
//
// Candidates are normalized defensively so this works for BOTH spec-shaped
// candidates ({scope, kind, subject, content, confidence, importance,
// valid_until, source_session, source_span:{start,end}}) and the legacy
// {key, value} shape. Missing fields get safe defaults; source_span is OPTIONAL
// (column is nullable) and only written when both start/end are present.
const SIM_UPDATE      = 0.92;   // near-identical → merge into existing
const SIM_CONFLICT_LO = 0.75;   // related but possibly contradicting → check supersede
const NEIGHBOR_K      = 5;

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

// Normalize a raw candidate (spec-shaped OR legacy {key,value}) into the fields
// saveMemoryCandidates relies on. Returns null if there's nothing to save.
function normalizeCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  const subjectRaw = c.subject ?? c.key;
  const contentRaw = c.content ?? c.value;
  if (!contentRaw) return null;

  const subject = String(subjectRaw ?? contentRaw).slice(0, 120);
  const content = String(contentRaw).slice(0, 500);

  // source_span is only valid when both ends are finite integers.
  // Normalize to a NON-EMPTY half-open range (start < end): swap if reversed
  // (int4range(7,3) throws), and bump end to start+1 when end<=start
  // (int4range(n,n) is the EMPTY range and silently drops single-message provenance).
  let span = null;
  const s = c.source_span;
  if (s && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end))) {
    let start = Math.trunc(Number(s.start));
    let end = Math.trunc(Number(s.end));
    if (start > end) { const t = start; start = end; end = t; }
    if (end <= start) end = start + 1;
    span = { start, end };
  }

  return {
    scope: typeof c.scope === 'string' && c.scope ? c.scope : 'semantic',
    kind: typeof c.kind === 'string' && c.kind ? c.kind : 'fact',
    subject,
    content,
    confidence: typeof c.confidence === 'number' ? clamp01(c.confidence) : 0.7,
    importance: typeof c.importance === 'number' ? clamp01(c.importance) : 0.5,
    valid_until: (typeof c.valid_until === 'string' && !Number.isNaN(Date.parse(c.valid_until))) ? c.valid_until : null,
    source_session: c.source_session ?? c.sourceSession ?? null,
    source_span: span,
  };
}

// Default LLM: raw fetch to Anthropic Messages API. Mirrors
// api/extract-memories.js:54-74. (system, user) => Promise<string of model text>.
function makeDefaultLLM() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return async (system, user) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Anthropic ${r.status}: ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    return data?.content?.[0]?.text || '';
  };
}

// Ask the LLM whether `incoming` makes `existing` false. One-word verdict.
// Spec :457-468. Fail-safe: on any LLM error, return 'related' so we INSERT the
// new fact rather than destructively superseding on an unverifiable verdict.
async function classifyContradiction(llm, existing, incoming) {
  const sys = `Classify the relationship between two memory statements. Respond with ONE word: contradicts, related, or unrelated. "contradicts" means the new statement makes the old one false.`;
  const user = `OLD: ${existing}\nNEW: ${incoming}`;
  let out = '';
  try {
    out = (await llm(sys, user)).trim().toLowerCase();
  } catch (e) {
    console.error('[memory] classifyContradiction LLM failed (treating as related):', e?.message || e);
    return 'related';
  }
  if (out.startsWith('contradicts')) return 'contradicts';
  if (out.startsWith('related'))     return 'related';
  if (out.startsWith('unrelated'))   return 'unrelated';
  // Unrecognized output → safest is 'related' (no destructive supersede).
  return 'related';
}

/**
 * Save memory candidates with embedding-based dedup + supersedes wiring.
 *
 * @param {import('pg').Pool} pool
 * @param {string} user_id
 * @param {Array<object>} candidates  spec-shaped or legacy {key,value}
 * @param {(system:string,user:string)=>Promise<string>} [llm]  contradiction judge;
 *        defaults to claude-haiku-4-5 via ANTHROPIC_API_KEY.
 * @returns {Promise<{inserted:number, updated:number, superseded:number, skipped:number}>}
 */
export async function saveMemoryCandidates(pool, user_id, candidates, llm) {
  if (!pool) pool = getPool();
  let inserted = 0, updated = 0, superseded = 0, skipped = 0;
  if (!user_id || !Array.isArray(candidates) || candidates.length === 0) {
    return { inserted, updated, superseded, skipped };
  }

  const judge = typeof llm === 'function' ? llm : makeDefaultLLM();

  for (const raw of candidates) {
    const c = normalizeCandidate(raw);
    if (!c) { skipped++; continue; }

    // Embed the candidate. If embedding fails, we can't run NN dedup — fall back
    // to a plain INSERT (without embedding) so the fact is still durably saved.
    let vec = null;
    try { vec = await embed(`${c.subject}: ${c.content}`); }
    catch (e) { console.error('[memory] candidate embed failed (inserting without vector):', e?.message || e); }

    if (!vec) {
      await pool.query(
        `INSERT INTO memory_items
           (user_id, scope, kind, subject, content,
            confidence, importance, valid_until, source_session, source_span)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${c.source_span ? 'int4range($10,$11)' : 'NULL'})`,
        c.source_span
          ? [user_id, c.scope, c.kind, c.subject, c.content,
             c.confidence, c.importance, c.valid_until, c.source_session,
             c.source_span.start, c.source_span.end]
          : [user_id, c.scope, c.kind, c.subject, c.content,
             c.confidence, c.importance, c.valid_until, c.source_session]
      );
      inserted++;
      continue;
    }

    const vlit = vecLiteral(vec);

    // Nearest neighbors within the SAME scope (spec :371-382).
    const neighbors = await pool.query(
      `SELECT id, kind, subject, content, confidence, importance,
              (embedding <=> $1::vector) AS distance
         FROM memory_items
        WHERE user_id = $2
          AND scope = $3
          AND embedding IS NOT NULL
          AND (valid_until IS NULL OR valid_until > now())
        ORDER BY embedding <=> $1::vector
        LIMIT $4`,
      [vlit, user_id, c.scope, NEIGHBOR_K]
    );

    // pgvector cosine distance = 1 - cosine_similarity → similarity = 1 - distance.
    const top = neighbors.rows[0];
    const topSim = top ? 1 - Number(top.distance) : 0;

    // MERGE (spec :389-404): near-identical. Replace content, lift confidence/
    // importance to the max of old vs new, refresh embedding + source provenance.
    // (updated_at is bumped automatically by trg_memory_touch — setup-memory-db.mjs:86-89.)
    if (top && topSim >= SIM_UPDATE) {
      await pool.query(
        `UPDATE memory_items
            SET content        = $1,
                embedding      = $2::vector,
                confidence     = GREATEST(confidence, $3),
                importance     = GREATEST(importance, $4),
                source_session = COALESCE($5, source_session)
                ${c.source_span ? ', source_span = int4range($7,$8)' : ''}
          WHERE id = $6`,
        c.source_span
          ? [c.content, vlit, c.confidence, c.importance, c.source_session, top.id,
             c.source_span.start, c.source_span.end]
          : [c.content, vlit, c.confidence, c.importance, c.source_session, top.id]
      );
      updated++;
      continue;
    }

    // POSSIBLE CONFLICT (spec :406-437): mid-similarity. Ask the LLM. If it
    // contradicts, supersede the old row inside a transaction.
    if (top && topSim >= SIM_CONFLICT_LO) {
      const verdict = judge
        ? await classifyContradiction(judge, top.content, c.content)
        : 'related'; // no LLM available → never destructively supersede
      if (verdict === 'contradicts') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE memory_items SET valid_until = now() WHERE id = $1`,
            [top.id]
          );
          await client.query(
            `INSERT INTO memory_items
               (user_id, scope, kind, subject, content, embedding,
                confidence, importance, valid_until, supersedes,
                source_session, source_span)
             VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9,$10,$11,${c.source_span ? 'int4range($12,$13)' : 'NULL'})`,
            c.source_span
              ? [user_id, c.scope, c.kind, c.subject, c.content, vlit,
                 c.confidence, c.importance, c.valid_until, top.id, c.source_session,
                 c.source_span.start, c.source_span.end]
              : [user_id, c.scope, c.kind, c.subject, c.content, vlit,
                 c.confidence, c.importance, c.valid_until, top.id, c.source_session]
          );
          await client.query('COMMIT');
          superseded++;
        } catch (e) {
          await client.query('ROLLBACK');
          client.release();
          throw e;
        }
        client.release();
        continue;
      }
      // 'related' or 'unrelated' → fall through to fresh insert.
    }

    // FRESH INSERT (spec :440-451).
    await pool.query(
      `INSERT INTO memory_items
         (user_id, scope, kind, subject, content, embedding,
          confidence, importance, valid_until, source_session, source_span)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9,$10,${c.source_span ? 'int4range($11,$12)' : 'NULL'})`,
      c.source_span
        ? [user_id, c.scope, c.kind, c.subject, c.content, vlit,
           c.confidence, c.importance, c.valid_until, c.source_session,
           c.source_span.start, c.source_span.end]
        : [user_id, c.scope, c.kind, c.subject, c.content, vlit,
           c.confidence, c.importance, c.valid_until, c.source_session]
    );
    inserted++;
  }

  return { inserted, updated, superseded, skipped };
}

async function readFacts(userId) {
  const pool = getPool();
  const sql = `
    SELECT id, subject AS key, content AS value, updated_at, created_at, importance, confidence
      FROM memory_items
     WHERE user_id = $1
       AND scope = 'semantic'
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
