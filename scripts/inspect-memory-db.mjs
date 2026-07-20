// scripts/inspect-memory-db.mjs — READ-ONLY inspection of the thinkinbuddy_memory Neon DB.
// Derives the connection from the neondb string in .claude.json (same Neon account, owner
// neondb_owner) and swaps the database name to thinkinbuddy_memory. Prints NO secrets.
// Run: node scripts/inspect-memory-db.mjs
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
// Grab the neondb connection string (handle possible & / escaped ampersands).
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('FAIL: no neondb connection string found in .claude.json'); process.exit(1); }
let neon = m[0].replace(/\\u0026/g, '&');
// Swap database name neondb -> thinkinbuddy_memory (keep query params).
const memConn = neon.replace(/\/neondb(\?|$)/, '/thinkinbuddy_memory$1');
const host = (memConn.match(/@([^/]+)\//) || [])[1] || '(?)';
console.log(`→ connecting to thinkinbuddy_memory on ${host} (read-only)\n`);

const pool = new Pool({ connectionString: memConn, ssl: { rejectUnauthorized: false }, max: 2 });

(async () => {
  const q = (sql, p) => pool.query(sql, p);
  try {
    const db = await q('SELECT current_database() AS db');
    console.log('current_database:', db.rows[0].db);

    const ext = await q(`SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pgcrypto')`);
    console.log('extensions:', ext.rows.map(r => `${r.extname} ${r.extversion}`).join(', ') || '(none of vector/pgcrypto)');

    const tbls = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    console.log('public tables:', tbls.rows.map(r => r.table_name).join(', ') || '(none)');

    const has = await q(`SELECT to_regclass('public.memory_items') IS NOT NULL AS exists`);
    console.log('memory_items exists:', has.rows[0].exists);

    if (has.rows[0].exists) {
      const cols = await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='memory_items' ORDER BY ordinal_position`);
      console.log('memory_items columns:', cols.rows.map(c => `${c.column_name}:${c.data_type}`).join(', '));

      const cnt = await q(`SELECT count(*)::int total,
                                  count(DISTINCT user_id)::int users,
                                  count(*) FILTER (WHERE embedding IS NOT NULL)::int with_embedding
                             FROM memory_items`);
      console.log('row stats:', JSON.stringify(cnt.rows[0]));

      const idx = await q(`SELECT indexname FROM pg_indexes WHERE tablename='memory_items' ORDER BY indexname`);
      console.log('indexes:', idx.rows.map(r => r.indexname).join(', ') || '(none)');

      const users = await q(`SELECT user_id, count(*)::int n FROM memory_items GROUP BY user_id ORDER BY n DESC LIMIT 10`);
      console.log('rows per user_id:', JSON.stringify(users.rows));

      const sample = await q(`SELECT user_id, kind, scope, left(subject,60) AS subject, created_at
                                FROM memory_items ORDER BY created_at DESC LIMIT 8`);
      console.log('sample rows (newest):');
      for (const r of sample.rows) console.log('  -', JSON.stringify(r));
    }
    console.log('\nOK: inspection complete (read-only, nothing written).');
  } catch (e) {
    console.error('ERROR:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
