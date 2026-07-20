// scripts/step2-backup-ids.mjs — READ-ONLY backup. Dumps (id, user_id) for ALL rows to
// scripts/memory-id-backup.json so the merge is fully reversible (revert = UPDATE back by id).
// Run: node scripts/step2-backup-ids.mjs
import { Pool } from 'pg';
import { readFileSync, writeFileSync } from 'fs';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('FAIL: no neondb connection string found in .claude.json'); process.exit(1); }
let neon = m[0].replace(/\\u0026/g, '&');
const memConn = neon.replace(/\/neondb(\?|$)/, '/thinkinbuddy_memory$1');
const OUT = 'C:/Users/troyh/n8n_Pod_Uploader_jarvis/jarvis/scripts/memory-id-backup.json';

const pool = new Pool({ connectionString: memConn, ssl: { rejectUnauthorized: false }, max: 2 });

(async () => {
  try {
    const r = await pool.query(`SELECT id, user_id FROM memory_items ORDER BY created_at ASC`);
    const payload = {
      taken_at: new Date().toISOString(),
      db: 'thinkinbuddy_memory',
      table: 'memory_items',
      note: 'Pre-merge backup of (id,user_id). Revert: UPDATE memory_items SET user_id=<orig> WHERE id=<id>.',
      count: r.rowCount,
      rows: r.rows,
    };
    writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`wrote ${r.rowCount} entries -> ${OUT}`);
  } catch (e) {
    console.error('ERROR:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
