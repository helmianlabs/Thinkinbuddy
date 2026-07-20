// Verify the batch0000 load actually landed in Neon claude_memory (source-of-truth check).
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
const conn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });

const ids = ['c6021bb0-0341-4fc3-b251-d3fb2794dc5c', '3997a317-4743-49d5-b0a1-1fb6b830e40f'];
const c = await pool.connect();
try {
  for (const id of ids) {
    const cv = (await c.query('select name,message_count from conversations where uuid=$1', [id])).rows[0];
    const mc = (await c.query('select count(*)::int n, count(distinct sender)::int s from messages where conversation_uuid=$1', [id])).rows[0];
    console.log('•', cv ? JSON.stringify(cv.name) : '(MISSING)', '| declared:', cv && cv.message_count, '| rows_in_messages:', mc.n, '| distinct_senders:', mc.s);
  }
  const tot = (await c.query('select (select count(*) from conversations)::int convs,(select count(*) from messages)::int msgs')).rows[0];
  console.log('DB totals now -> conversations:', tot.convs, '| messages:', tot.msgs);
  const samp = (await c.query('select sender,left(text,90) t from messages where conversation_uuid=$1 order by turn_index limit 2', [ids[1]])).rows;
  samp.forEach(r => console.log('  sample:', r.sender, '=>', JSON.stringify(r.t)));
} finally { c.release(); await pool.end(); }
