// scripts/setup-memory-db.mjs
// ---------------------------------------------------------------------------
// ONE-SHOT, IDEMPOTENT setup + verify for Mark / ThinkinBuddy's Neon memory DB.
//
// WHY THIS EXISTS: as of 2026-06-09 the Vercel `thinkbuddy` prod env var
// DATABASE_URL_MEMORY is an EMPTY STRING, so every /api/memory call returns
// 500 "memory store not configured". The memory CODE is correct; it just has
// no database behind it. This script wires whatever connection string you give
// it into a fully-formed schema, then PROVES recall works end-to-end.
//
// It is SAFE TO RE-RUN: every DDL uses IF NOT EXISTS; the verify step inserts a
// clearly-fake probe row (user_id = '__setup_probe__'), runs a cosine query,
// then deletes ONLY that probe row. It never touches real memories.
//
// USAGE (from thinkinbuddy/ project root):
//   node scripts/setup-memory-db.mjs "postgresql://USER:PASS@HOST/db?sslmode=require"
// or set the env var first and run with no arg:
//   $env:DATABASE_URL_MEMORY="postgresql://..."; node scripts/setup-memory-db.mjs
//
// After it prints "✅ ALL CHECKS PASSED", wire the same string into Vercel:
//   vercel env add DATABASE_URL_MEMORY production   (paste the string)
//   vercel --prod   (redeploy so the function picks it up)
// ---------------------------------------------------------------------------

import { Pool } from 'pg';

const conn = process.argv[2] || process.env.DATABASE_URL_MEMORY || process.env.DATABASE_URL;
if (!conn || conn.trim().length < 12) {
  console.error('✗ No connection string. Pass it as arg 1 or set DATABASE_URL_MEMORY.');
  console.error('  node scripts/setup-memory-db.mjs "postgresql://user:pass@host/db?sslmode=require"');
  process.exit(1);
}

// Mask credentials when echoing which host we are about to touch.
const masked = conn.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
console.log(`→ Target: ${masked}`);

const pool = new Pool({
  connectionString: conn,
  max: 2,
  idleTimeoutMillis: 10_000,
  ssl: { rejectUnauthorized: false },
});

// Full schema per docs/persistent-memory-spec-2026-05-27.md (lines 26-62),
// with blob_url folded in from docs/migration-media-memory-2026-06-06.sql.
const DDL = [
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `CREATE TABLE IF NOT EXISTS memory_items (
     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id         TEXT NOT NULL,
     scope           TEXT NOT NULL,
     kind            TEXT NOT NULL,
     subject         TEXT NOT NULL,
     content         TEXT NOT NULL,
     embedding       VECTOR(1536),
     confidence      REAL NOT NULL DEFAULT 0.7,
     importance      REAL NOT NULL DEFAULT 0.5,
     valid_until     TIMESTAMPTZ,
     supersedes      UUID REFERENCES memory_items(id) ON DELETE SET NULL,
     source_session  TEXT,
     source_span     INT4RANGE,
     blob_url        TEXT,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // In case the table pre-existed from an out-of-band create without these:
  `ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS blob_url TEXT`,
  `ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS source_span INT4RANGE`,
  `CREATE INDEX IF NOT EXISTS idx_memory_user_scope  ON memory_items (user_id, scope)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_valid_until ON memory_items (valid_until) WHERE valid_until IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_memory_kind        ON memory_items (kind)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_importance  ON memory_items (importance DESC, confidence DESC, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_embedding_hnsw
     ON memory_items USING hnsw (embedding vector_cosine_ops)
     WITH (m = 16, ef_construction = 64)`,
  `CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
     BEGIN NEW.updated_at = now(); RETURN NEW; END;
   $$ LANGUAGE plpgsql`,
];

const TRIGGER = `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_memory_touch') THEN
      CREATE TRIGGER trg_memory_touch BEFORE UPDATE ON memory_items
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    END IF;
  END $$;`;

function dummyVec() {
  // A normalized-ish 1536-d vector so the cosine operator has something real.
  return '[' + Array.from({ length: 1536 }, (_, i) => (i % 7 === 0 ? 0.05 : 0.001)).join(',') + ']';
}

(async () => {
  const client = await pool.connect();
  try {
    console.log('\n[1/4] Applying schema (idempotent)...');
    for (const sql of DDL) { await client.query(sql); }
    await client.query(TRIGGER);
    console.log('      schema OK (extensions, table, indexes, trigger).');

    console.log('[2/4] Inspecting existing data (your real memories, if any)...');
    const { rows: stat } = await client.query(`
      SELECT count(*)::int AS total,
             count(DISTINCT user_id)::int AS users,
             count(*) FILTER (WHERE embedding IS NOT NULL)::int AS with_embedding,
             count(*) FILTER (WHERE blob_url IS NOT NULL)::int AS media
        FROM memory_items WHERE user_id <> '__setup_probe__'`);
    console.log(`      existing rows: ${stat[0].total} (users: ${stat[0].users}, with embedding: ${stat[0].with_embedding}, media: ${stat[0].media})`);

    console.log('[3/4] Probe write + cosine recall (proves the hot path)...');
    const v = dummyVec();
    await client.query(`DELETE FROM memory_items WHERE user_id = '__setup_probe__'`); // clean any prior probe
    await client.query(
      `INSERT INTO memory_items (user_id, scope, kind, subject, content, embedding, confidence, importance)
       VALUES ('__setup_probe__','semantic','fact','setup probe','verifying cosine recall works', $1::vector, 0.9, 0.9)`,
      [v]
    );
    const { rows: recall } = await client.query(
      `SELECT subject, (embedding <=> $1::vector) AS distance
         FROM memory_items
        WHERE user_id = '__setup_probe__' AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector LIMIT 1`,
      [v]
    );
    const probeOK = recall.length === 1 && Number(recall[0].distance) < 1e-6;
    console.log(`      recall returned ${recall.length} row(s), self-distance=${recall[0]?.distance} → ${probeOK ? 'OK' : 'UNEXPECTED'}`);

    console.log('[4/4] Cleaning up probe row...');
    const del = await client.query(`DELETE FROM memory_items WHERE user_id = '__setup_probe__'`);
    console.log(`      removed ${del.rowCount} probe row(s).`);

    if (!probeOK) throw new Error('probe recall did not behave as expected — investigate before trusting recall');
    console.log('\n✅ ALL CHECKS PASSED — memory DB is live, vector recall works.');
    console.log('   Next: set this SAME string as DATABASE_URL_MEMORY in Vercel (production) and redeploy.');
  } catch (err) {
    console.error('\n✗ SETUP FAILED:', err?.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
