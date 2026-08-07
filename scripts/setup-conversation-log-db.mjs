// scripts/setup-conversation-log-db.mjs
// ---------------------------------------------------------------------------
// ONE-SHOT, IDEMPOTENT setup for the CONTINUOUS conversation transcript log.
//
// WHY THIS EXISTS: memory_items (setup-memory-db.mjs) stores extracted FACTS,
// not the raw conversation. Troy lost a ~15-minute conversation because
// nothing durable stored the actual dialogue as it happened -- extraction
// only ran (unreliably) after the call ended. This adds two tables:
//
//   conversation_sessions -- one row per call, keyed by a LOCALLY-GENERATED
//     session id (crypto.randomUUID(), created client-side the instant a call
//     starts) so turn-saving never blocks on capturing ElevenLabs' own
//     conversation_id first (that capture is the fragile part of the old
//     design). conversation_id is filled in opportunistically once known,
//     and is what the post-call webhook uses to reconcile/link back.
//
//   conversation_turns -- one row per turn, written LIVE as each turn happens
//     (api/conversation-turn.js, called from index.html's onMessage hook),
//     PLUS reconciled/backfilled by the ElevenLabs post-call webhook
//     (api/conversation-webhook.js) once the call ends, so a turn is never
//     lost even if a single live POST fails. `raw` stores the original
//     client/webhook payload verbatim as a durability net against field-name
//     assumptions being wrong.
//
// SAFE TO RE-RUN: every DDL uses IF NOT EXISTS.
//
// USAGE (from thinkinbuddy/ project root):
//   node scripts/setup-conversation-log-db.mjs "postgresql://USER:PASS@HOST/db?sslmode=require"
// or set the env var first:
//   $env:DATABASE_URL_MEMORY="postgresql://..."; node scripts/setup-conversation-log-db.mjs
// ---------------------------------------------------------------------------

import { Pool } from 'pg';

const conn = process.argv[2] || process.env.DATABASE_URL_MEMORY || process.env.DATABASE_URL;
if (!conn || conn.trim().length < 12) {
  console.error('✗ No connection string. Pass it as arg 1 or set DATABASE_URL_MEMORY.');
  process.exit(1);
}

const masked = conn.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
console.log(`→ Target: ${masked}`);

const pool = new Pool({
  connectionString: conn,
  max: 2,
  idleTimeoutMillis: 10_000,
  ssl: { rejectUnauthorized: false },
});

const DDL = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `CREATE TABLE IF NOT EXISTS conversation_sessions (
     id               UUID PRIMARY KEY,
     user_id          TEXT NOT NULL,
     conversation_id  TEXT,
     agent_id         TEXT,
     started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     ended_at         TIMESTAMPTZ,
     end_reason       TEXT,
     turn_count       INT NOT NULL DEFAULT 0,
     reconciled       BOOLEAN NOT NULL DEFAULT false,
     source           TEXT NOT NULL DEFAULT 'elevenlabs_widget',
     summary          TEXT,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_sessions_convid
     ON conversation_sessions (conversation_id) WHERE conversation_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_conv_sessions_user_started
     ON conversation_sessions (user_id, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS conversation_turns (
     id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     session_id   UUID NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
     turn_index   INT NOT NULL,
     role         TEXT NOT NULL,
     content      TEXT,
     raw          JSONB,
     source       TEXT NOT NULL DEFAULT 'live',
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (session_id, turn_index)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_conv_turns_session ON conversation_turns (session_id, turn_index)`,
  `CREATE OR REPLACE FUNCTION touch_conv_session_updated_at() RETURNS TRIGGER AS $$
     BEGIN NEW.updated_at = now(); RETURN NEW; END;
   $$ LANGUAGE plpgsql`,
];

const TRIGGER = `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_conv_session_touch') THEN
      CREATE TRIGGER trg_conv_session_touch BEFORE UPDATE ON conversation_sessions
        FOR EACH ROW EXECUTE FUNCTION touch_conv_session_updated_at();
    END IF;
  END $$;`;

(async () => {
  const client = await pool.connect();
  try {
    console.log('\n[1/3] Applying schema (idempotent)...');
    for (const sql of DDL) { await client.query(sql); }
    await client.query(TRIGGER);
    console.log('      schema OK (conversation_sessions, conversation_turns, indexes, trigger).');

    console.log('[2/3] Inspecting existing data...');
    const { rows: stat } = await client.query(`
      SELECT (SELECT count(*)::int FROM conversation_sessions) AS sessions,
             (SELECT count(*)::int FROM conversation_turns) AS turns`);
    console.log(`      existing sessions: ${stat[0].sessions}, turns: ${stat[0].turns}`);

    console.log('[3/3] Probe write + read (proves the hot path)...');
    const probeSessionId = '00000000-0000-0000-0000-000000000001';
    await client.query(`DELETE FROM conversation_sessions WHERE id = $1`, [probeSessionId]);
    await client.query(
      `INSERT INTO conversation_sessions (id, user_id, source) VALUES ($1, '__setup_probe__', 'setup-probe')`,
      [probeSessionId]
    );
    await client.query(
      `INSERT INTO conversation_turns (session_id, turn_index, role, content, raw)
       VALUES ($1, 0, 'user', 'probe turn', '{"probe":true}'::jsonb)`,
      [probeSessionId]
    );
    const { rows: readback } = await client.query(
      `SELECT t.content FROM conversation_turns t WHERE t.session_id = $1`,
      [probeSessionId]
    );
    const probeOK = readback.length === 1 && readback[0].content === 'probe turn';
    console.log(`      probe readback: ${JSON.stringify(readback)} -> ${probeOK ? 'OK' : 'UNEXPECTED'}`);
    await client.query(`DELETE FROM conversation_sessions WHERE id = $1`, [probeSessionId]); // cascades to the probe turn

    if (!probeOK) throw new Error('probe readback did not behave as expected — investigate before trusting this table');
    console.log('\n✅ ALL CHECKS PASSED — conversation log DB is live.');
  } catch (err) {
    console.error('\n✗ SETUP FAILED:', err?.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
