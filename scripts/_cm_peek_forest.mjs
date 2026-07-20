import { Pool } from 'pg';
const raw = (await import('fs')).readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
const conn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });
const r = await pool.query("select uuid, left(name,90) name, created_at, message_count from conversations where name like 'CENTAUR ANIM QA 2026-06-22%' order by created_at");
console.log('ROWS', r.rowCount);
for (const x of r.rows) console.log(x.created_at, '|', x.uuid, '|', x.name);
await pool.end();
