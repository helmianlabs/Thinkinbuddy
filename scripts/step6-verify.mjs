// scripts/step6-verify.mjs — READ-ONLY final verification of the merge + backfill.
// Run: node scripts/step6-verify.mjs
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
const memConn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/thinkinbuddy_memory$1');
const pool = new Pool({ connectionString: memConn, ssl: { rejectUnauthorized: false }, max: 2 });

(async () => {
  try {
    const dist = await pool.query(`SELECT user_id, count(*)::int n FROM memory_items GROUP BY user_id ORDER BY n DESC`);
    console.log('FINAL distribution:');
    for (const r of dist.rows) console.log(`  ${r.user_id}: ${r.n}`);

    const troy = await pool.query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE embedding IS NOT NULL)::int with_emb,
              count(*) FILTER (WHERE embedding IS NULL)::int null_emb
         FROM memory_items WHERE user_id='troy'`);
    console.log("\ntroy:", JSON.stringify(troy.rows[0]));

    const total = await pool.query(`SELECT count(*)::int n FROM memory_items`);
    console.log('grand total rows:', total.rows[0].n);
  } catch (e) {
    console.error('ERROR:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
