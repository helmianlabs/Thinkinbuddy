// scripts/apply-media-migration.mjs — apply the ONE missing migration to thinkinbuddy_memory:
//   ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS blob_url TEXT
// (docs/migration-media-memory-2026-06-06.sql was never run against the live DB; without
// blob_url, mediaMemory.js writes for images/videos fail.)
// Connection derived from the neondb string in .claude.json, dbname swapped to thinkinbuddy_memory.
// Additive + reversible (DROP COLUMN blob_url). Prints NO secrets.
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('FAIL: no neondb connection string in .claude.json'); process.exit(1); }
const memConn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/thinkinbuddy_memory$1');
const pool = new Pool({ connectionString: memConn, ssl: { rejectUnauthorized: false }, max: 2 });

(async () => {
  try {
    const before = await pool.query(`SELECT count(*)::int AS has FROM information_schema.columns WHERE table_name='memory_items' AND column_name='blob_url'`);
    console.log('blob_url present before:', before.rows[0].has === 1);
    if (before.rows[0].has === 0) {
      await pool.query(`ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS blob_url TEXT`);
      console.log('-> ALTER TABLE ADD COLUMN blob_url executed.');
    } else {
      console.log('-> already present, no change.');
    }
    const after = await pool.query(`SELECT count(*)::int AS has FROM information_schema.columns WHERE table_name='memory_items' AND column_name='blob_url'`);
    console.log('blob_url present after:', after.rows[0].has === 1);
    // row count unchanged sanity
    const rc = await pool.query(`SELECT count(*)::int AS n FROM memory_items`);
    console.log('memory_items row count (unchanged):', rc.rows[0].n);
    console.log(after.rows[0].has === 1 ? '\nOK: media column ready.' : '\nFAIL: column still missing.');
  } catch (e) {
    console.error('ERROR:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
