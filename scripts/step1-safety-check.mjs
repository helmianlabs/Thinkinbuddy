// scripts/step1-safety-check.mjs — READ-ONLY. Prints subject + left(content,100) for the two
// candidate Troy user_ids so we can confirm both belong to ONE person before any merge.
// Run: node scripts/step1-safety-check.mjs
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('FAIL: no neondb connection string found in .claude.json'); process.exit(1); }
let neon = m[0].replace(/\\u0026/g, '&');
const memConn = neon.replace(/\/neondb(\?|$)/, '/thinkinbuddy_memory$1');

const pool = new Pool({ connectionString: memConn, ssl: { rejectUnauthorized: false }, max: 2 });
const IDS = ['u_mp1f3n9i_oo4zv6', 'u_mpn9qosp_7b2y1m'];

(async () => {
  try {
    for (const id of IDS) {
      const r = await pool.query(
        `SELECT subject, left(content,100) AS content, created_at
           FROM memory_items WHERE user_id=$1 ORDER BY created_at ASC`, [id]);
      console.log(`\n========== ${id}  (${r.rowCount} rows) ==========`);
      for (const row of r.rows) {
        console.log(`  [${row.subject}] -> ${String(row.content).replace(/\s+/g, ' ').trim()}`);
      }
    }
    console.log('\nOK: read-only safety dump complete.');
  } catch (e) {
    console.error('ERROR:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
