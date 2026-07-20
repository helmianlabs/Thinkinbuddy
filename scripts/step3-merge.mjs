// scripts/step3-merge.mjs — WRITE. Merges Troy's two per-browser user_ids into canonical 'troy'.
// Transaction-wrapped, fail-closed. Leaves the 3 test rows untouched.
// Run: node scripts/step3-merge.mjs
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('FAIL: no neondb connection string found in .claude.json'); process.exit(1); }
let neon = m[0].replace(/\\u0026/g, '&');
const memConn = neon.replace(/\/neondb(\?|$)/, '/thinkinbuddy_memory$1');

const pool = new Pool({ connectionString: memConn, ssl: { rejectUnauthorized: false }, max: 2 });
const FROM = ['u_mp1f3n9i_oo4zv6', 'u_mpn9qosp_7b2y1m'];

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE memory_items SET user_id='troy', updated_at=now()
         WHERE user_id = ANY($1::text[])`, [FROM]);
    console.log('rows updated:', upd.rowCount);

    // Verify inside the txn before committing.
    const chk = await client.query(
      `SELECT user_id, count(*)::int n FROM memory_items GROUP BY user_id ORDER BY n DESC`);
    const map = Object.fromEntries(chk.rows.map(r => [r.user_id, r.n]));
    console.log('post-update distribution (uncommitted):', JSON.stringify(map));

    const troyN = map['troy'] || 0;
    const leftover = (map['u_mp1f3n9i_oo4zv6'] || 0) + (map['u_mpn9qosp_7b2y1m'] || 0);
    if (troyN !== 52 || leftover !== 0) {
      throw new Error(`unexpected counts: troy=${troyN} (want 52), leftover=${leftover} (want 0) -> ROLLBACK`);
    }
    await client.query('COMMIT');
    console.log('COMMIT ok. troy now holds', troyN, 'rows; 3 test rows untouched.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ERROR (rolled back):', e?.message || e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
