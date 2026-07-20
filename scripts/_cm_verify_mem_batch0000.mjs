// Confirm the 2026-06-22 memory snapshot landed in Neon claude_memory.
import { Pool } from 'pg';
import { readFileSync } from 'fs';
const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
const conn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });
const c = await pool.connect();
try {
  const cv = (await c.query("select name,message_count from conversations where uuid='claudeai-memory-snapshot-20260622'")).rows[0];
  const mc = (await c.query("select count(*)::int n, sum(length(text))::int chars from messages where conversation_uuid='claudeai-memory-snapshot-20260622'")).rows[0];
  console.log('snapshot row:', cv ? JSON.stringify(cv.name) : '(MISSING)', '| blocks declared:', cv && cv.message_count, '| block rows:', mc.n, '| total chars:', mc.chars);
  const samp = (await c.query("select left(text,110) t from messages where conversation_uuid='claudeai-memory-snapshot-20260622' order by turn_index limit 1")).rows[0];
  if (samp) console.log('sample:', JSON.stringify(samp.t));
} finally { c.release(); await pool.end(); }
