// lib/mediaMemory.js — write and recall media (image/video) rows in memory_items.
//
// Reuses the shared pool + embed helpers from api/memory.js so we hit the same
// Neon connection pool and the same OpenAI key.  Nothing new is configured.
//
// Schema note: media rows live alongside text facts in memory_items.  They
// differ only in kind ('image' | 'video') and have a non-null blob_url column
// (added by docs/migration-media-memory-2026-06-06.sql).
//
// Exported functions:
//   saveMediaMemory({ userId, type, blobUrl, prompt, createdAt? })
//     → writes one row; fires-and-forgets embedding (failure is non-fatal).
//   retrieveMedia({ userId, query, limit })
//     → cosine similarity on the query embedding, mixed with a recency bonus,
//       returns [{id, type, blobUrl, caption, createdAt, score}] newest-first.

import { getPool, embed, vecLiteral } from '../server/handlers/memory.js';

/**
 * Save a media row into memory_items.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {'image'|'video'} opts.type
 * @param {string} opts.blobUrl  — public Vercel Blob URL
 * @param {string} opts.prompt   — the generation prompt / caption
 * @param {number} [opts.createdAt]  — unix ms timestamp (defaults to Date.now())
 */
export async function saveMediaMemory({ userId, type, blobUrl, prompt, createdAt }) {
  if (!userId || !blobUrl || !prompt) return;
  const pool = getPool();
  const kind    = type === 'video' ? 'video' : 'image';
  const subject = String(prompt).slice(0, 120);
  const content = String(prompt).slice(0, 500);
  const ts      = createdAt ? new Date(createdAt) : new Date();

  let vec = null;
  try {
    vec = await embed(prompt);
  } catch (e) {
    console.error('[mediaMemory] embed failed (non-fatal):', e?.message || e);
  }

  try {
    await pool.query(
      `INSERT INTO memory_items
         (user_id, scope, kind, subject, content, blob_url, embedding,
          confidence, importance, created_at, updated_at)
       VALUES ($1, 'semantic', $2, $3, $4, $5, ${vec ? '$6::vector' : 'NULL'},
               0.8, 0.7, $${vec ? 7 : 6}, $${vec ? 8 : 7})`,
      vec
        ? [userId, kind, subject, content, blobUrl, vecLiteral(vec), ts, ts]
        : [userId, kind, subject, content, blobUrl, ts, ts]
    );
  } catch (err) {
    console.error('[mediaMemory] INSERT failed:', err?.message || err);
  }
}

/**
 * Retrieve past media for a user, ranked by cosine similarity to a text query
 * plus a recency bonus, or by recency alone when no query is provided.
 *
 * Ranking formula (when query provided):
 *   score = (1 - cosine_distance) * 0.7  +  recency_score * 0.3
 *   recency_score = exp(-age_days / 30)   so items within ~30 days stay relevant
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.query]   — optional natural-language recall query
 * @param {number} [opts.limit]   — default 30
 * @param {'image'|'video'|'all'} [opts.mediaType] — filter by kind
 * @returns {Promise<Array<{id,type,blobUrl,caption,createdAt,score}>>}
 */
export async function retrieveMedia({ userId, query, limit = 30, mediaType = 'all' }) {
  if (!userId) return [];
  const pool = getPool();

  const kindFilter = mediaType === 'image'
    ? `AND kind = 'image'`
    : mediaType === 'video'
      ? `AND kind = 'video'`
      : `AND kind IN ('image','video')`;

  // With query: cosine similarity + recency blend
  if (query) {
    let vec = null;
    try {
      vec = await embed(query);
    } catch (e) {
      console.error('[mediaMemory] embed for recall failed:', e?.message || e);
    }

    if (vec) {
      const { rows } = await pool.query(
        `SELECT id,
                kind                AS type,
                blob_url            AS "blobUrl",
                content             AS caption,
                created_at          AS "createdAt",
                (
                  (1 - (embedding <=> $2::vector)) * 0.7
                  + EXP(-EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0 / 30.0) * 0.3
                )                   AS score
           FROM memory_items
          WHERE user_id = $1
            AND blob_url IS NOT NULL
            AND embedding IS NOT NULL
            AND (valid_until IS NULL OR valid_until > now())
            AND supersedes IS NULL
            ${kindFilter}
          ORDER BY score DESC
          LIMIT $3`,
        [userId, vecLiteral(vec), limit]
      );
      return rows;
    }
    // Embedding failed — fall through to recency-only
  }

  // Recency-only fallback (or no query)
  const { rows } = await pool.query(
    `SELECT id,
            kind       AS type,
            blob_url   AS "blobUrl",
            content    AS caption,
            created_at AS "createdAt",
            importance AS score
       FROM memory_items
      WHERE user_id = $1
        AND blob_url IS NOT NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND supersedes IS NULL
        ${kindFilter}
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}
