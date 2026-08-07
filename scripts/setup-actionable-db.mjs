// scripts/setup-actionable-db.mjs
// ---------------------------------------------------------------------------
// ONE-SHOT, IDEMPOTENT schema setup for Actionable. Safe to re-run.
//
// Follows the shape of scripts/setup-memory-db.mjs: every DDL is IF NOT EXISTS,
// the verify step writes a clearly-fake probe row under user_id '__setup_probe__'
// and deletes only that row, and it never touches real data.
//
// It shares the memory database (DATABASE_URL_MEMORY) but uses its OWN tables.
// memory_items is neither read nor written here.
//
// USAGE (from thinkinbuddy/):
//   node scripts/setup-actionable-db.mjs "postgresql://USER:PASS@HOST/db?sslmode=require"
// or, with the env var already set:
//   node scripts/setup-actionable-db.mjs
// ---------------------------------------------------------------------------

import { Pool } from 'pg';

const conn = process.argv[2] || process.env.DATABASE_URL_MEMORY || process.env.DATABASE_URL;
if (!conn || conn.trim().length < 12) {
  console.error('✗ No connection string. Pass it as arg 1 or set DATABASE_URL_MEMORY.');
  process.exit(1);
}
console.log(`→ Target: ${conn.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@')}`);

// SSL for anything remote (Neon requires it), off for a local cluster — a
// throwaway Postgres on localhost speaks plaintext and an unconditional
// `ssl: {...}` fails it with "The server does not support SSL connections",
// which is exactly the setup you want when verifying this script before
// pointing it at real data.
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(conn) || /sslmode=disable/.test(conn);
const pool = new Pool({
  connectionString: conn, max: 2, idleTimeoutMillis: 10_000,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

const DDL = [
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,

  // The user's editable category set. Categories live HERE, not in code.
  `CREATE TABLE IF NOT EXISTS actionable_projects (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id     TEXT NOT NULL,
     slug        TEXT NOT NULL,
     label       TEXT NOT NULL,
     hint        TEXT DEFAULT '',
     color       TEXT,
     sort_order  INT NOT NULL DEFAULT 100,
     archived    BOOLEAN NOT NULL DEFAULT false,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Named so ON CONFLICT (user_id, slug) in db.js has a constraint to bind to.
  // Without this the upsert throws "no unique or exclusion constraint matching".
  `CREATE UNIQUE INDEX IF NOT EXISTS actionable_projects_user_slug
     ON actionable_projects (user_id, slug)`,

  `CREATE TABLE IF NOT EXISTS actionable_settings (
     user_id           TEXT PRIMARY KEY,
     timezone          TEXT NOT NULL DEFAULT 'America/Denver',
     sheets_webhook    TEXT,
     docs_webhook      TEXT,
     sheet_id          TEXT,
     doc_folder_id     TEXT,
     numeric_threshold INT NOT NULL DEFAULT 3,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS actionable_google_accounts (
     user_id       TEXT PRIMARY KEY,
     refresh_token TEXT,
     access_token  TEXT,
     expires_at    TIMESTAMPTZ,
     email         TEXT,
     scopes        TEXT,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // Every non-Google integration. Google keeps actionable_google_accounts above
  // because that code shipped first; the provider interface hides the split.
  //
  // target_url holds the Zapier/Make/Apps-Script URL. For those services the URL
  // IS the credential, so it is as sensitive as a token and is masked whenever
  // it is read back out (integrations/store.js maskUrl).
  `CREATE TABLE IF NOT EXISTS actionable_connections (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id       TEXT NOT NULL,
     provider      TEXT NOT NULL,
     access_token  TEXT,
     refresh_token TEXT,
     expires_at    TIMESTAMPTZ,
     account_label TEXT,
     target_url    TEXT,
     config        JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Named so ON CONFLICT (user_id, provider) has a constraint to bind to —
  // without it the upsert throws "no unique or exclusion constraint matching".
  `CREATE UNIQUE INDEX IF NOT EXISTS actionable_connections_user_provider
     ON actionable_connections (user_id, provider)`,

  // One row per recording.
  `CREATE TABLE IF NOT EXISTS actionable_entries (
     id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id               TEXT NOT NULL,
     title                 TEXT NOT NULL,
     summary               TEXT DEFAULT '',
     transcript            TEXT DEFAULT '',
     search_text           TEXT NOT NULL DEFAULT '',
     embedding             VECTOR(1536),
     image_url             TEXT,
     image_mime            TEXT,
     image_text            TEXT,
     image_description     TEXT,
     people                TEXT[] DEFAULT '{}',
     open_questions        TEXT[] DEFAULT '{}',
     unclear               TEXT[] DEFAULT '{}',
     numbers               JSONB DEFAULT '[]'::jsonb,
     transcription_repairs JSONB DEFAULT '[]'::jsonb,
     raw                   JSONB,
     doc_url               TEXT,
     doc_id                TEXT,
     sheet_logged          BOOLEAN,
     source                TEXT DEFAULT 'app',
     timezone              TEXT DEFAULT 'America/Denver',
     captured_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
     created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // GENERATED, not trigger-maintained: the index physically cannot drift out of
  // sync with the text it indexes, and there is no ordering hazard on insert.
  `ALTER TABLE actionable_entries
     ADD COLUMN IF NOT EXISTS search_tsv tsvector
     GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_text,''))) STORED`,

  `CREATE INDEX IF NOT EXISTS actionable_entries_tsv     ON actionable_entries USING gin (search_tsv)`,
  `CREATE INDEX IF NOT EXISTS actionable_entries_user_at ON actionable_entries (user_id, captured_at DESC)`,
  `CREATE INDEX IF NOT EXISTS actionable_entries_trgm    ON actionable_entries (user_id) INCLUDE (title)`,
  `CREATE INDEX IF NOT EXISTS actionable_entries_vec
     ON actionable_entries USING hnsw (embedding vector_cosine_ops)
     WITH (m = 16, ef_construction = 64)`,

  // Many items per entry — the core structural fix over the old one-category row.
  `CREATE TABLE IF NOT EXISTS actionable_items (
     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     entry_id       UUID NOT NULL REFERENCES actionable_entries(id) ON DELETE CASCADE,
     user_id        TEXT NOT NULL,
     position       INT NOT NULL DEFAULT 0,
     kind           TEXT NOT NULL DEFAULT 'note',
     text           TEXT NOT NULL,
     detail         TEXT DEFAULT '',
     project        TEXT NOT NULL DEFAULT 'personal',
     project_is_new BOOLEAN NOT NULL DEFAULT false,
     tags           TEXT[] NOT NULL DEFAULT '{}',
     priority       TEXT NOT NULL DEFAULT 'medium',
     due_raw        TEXT,
     due_at         TIMESTAMPTZ,
     phone_action   JSONB DEFAULT '{}'::jsonb,
     done           BOOLEAN NOT NULL DEFAULT false,
     done_at        TIMESTAMPTZ,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS actionable_items_entry   ON actionable_items (entry_id)`,
  `CREATE INDEX IF NOT EXISTS actionable_items_project ON actionable_items (user_id, project)`,
  `CREATE INDEX IF NOT EXISTS actionable_items_tags    ON actionable_items USING gin (tags)`,
  `CREATE INDEX IF NOT EXISTS actionable_items_open
     ON actionable_items (user_id, done, due_at) WHERE done = false`,
];

const PROBE = '__setup_probe__';

(async () => {
  const client = await pool.connect();
  try {
    console.log('\n[1/5] Applying schema (idempotent)...');
    for (const sql of DDL) await client.query(sql);
    console.log('      schema OK — 5 tables, 9 indexes, generated tsvector column.');

    console.log('[2/5] Existing data (untouched):');
    const { rows: stat } = await client.query(`
      SELECT (SELECT count(*) FROM actionable_entries WHERE user_id <> $1)::int AS entries,
             (SELECT count(*) FROM actionable_items   WHERE user_id <> $1)::int AS items,
             (SELECT count(DISTINCT user_id) FROM actionable_entries WHERE user_id <> $1)::int AS users`,
      [PROBE]);
    console.log(`      entries: ${stat[0].entries}, items: ${stat[0].items}, users: ${stat[0].users}`);

    console.log('[3/5] Probe write (entry + 2 items)...');
    await client.query(`DELETE FROM actionable_entries WHERE user_id = $1`, [PROBE]);
    const { rows: ins } = await client.query(
      `INSERT INTO actionable_entries (user_id, title, summary, transcript, search_text)
       VALUES ($1,'setup probe','verifying search works',
               'drainage issue on the north side of building C, need a plumber by Friday',
               'setup probe verifying search works drainage issue north side building C plumber Friday')
       RETURNING id`, [PROBE]);
    const entryId = ins[0].id;
    await client.query(
      `INSERT INTO actionable_items (entry_id, user_id, position, kind, text, project, tags, priority)
       VALUES ($1,$2,0,'task','Get a plumber out to building C by Friday','product',ARRAY['drainage'],'high'),
              ($1,$2,1,'note','North side has standing water','product',ARRAY['drainage'],'low')`,
      [entryId, PROBE]);

    console.log('[4/5] Full-text recall + tag filter (proves the hot path)...');
    const { rows: hit } = await client.query(
      `SELECT title, ts_rank(search_tsv, websearch_to_tsquery('english','plumber')) AS rank
         FROM actionable_entries
        WHERE user_id = $1 AND search_tsv @@ websearch_to_tsquery('english','plumber')`, [PROBE]);
    const { rows: tagHit } = await client.query(
      `SELECT count(*)::int AS n FROM actionable_items WHERE user_id = $1 AND 'drainage' = ANY(tags)`, [PROBE]);
    const { rows: miss } = await client.query(
      `SELECT count(*)::int AS n FROM actionable_entries
        WHERE user_id = $1 AND search_tsv @@ websearch_to_tsquery('english','helicopter')`, [PROBE]);

    console.log(`      "plumber"    → ${hit.length} entry (rank ${hit[0]?.rank?.toFixed?.(4) ?? 'n/a'})`);
    console.log(`      tag drainage → ${tagHit[0].n} items`);
    console.log(`      "helicopter" → ${miss[0].n} entries  (negative control — must be 0)`);

    // Both directions must hold. A search that returns everything is as broken
    // as one that returns nothing, and only the negative control catches it.
    const ok = hit.length === 1 && tagHit[0].n === 2 && miss[0].n === 0;

    console.log('[5/5] Removing probe rows...');
    const del = await client.query(`DELETE FROM actionable_entries WHERE user_id = $1`, [PROBE]);
    console.log(`      removed ${del.rowCount} probe entry (items cascade).`);

    if (!ok) throw new Error('search did not behave as expected — do not trust recall until this passes');
    console.log('\n✅ ALL CHECKS PASSED — Actionable schema is live and search works.');
    console.log('   Next: docs/ACTIONABLE_SETUP.md step 3 onward.');
  } catch (err) {
    console.error('\n✗ SETUP FAILED:', err?.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
