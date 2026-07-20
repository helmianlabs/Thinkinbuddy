// Load Claude.ai memories.json (the distilled cross-conversation + project memory)
// into Neon claude_memory as ONE searchable conversation snapshot. Idempotent (stable uuid).
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('NO_NEON_STRING'); process.exit(1); }
const base = m[0].replace(/\\u0026/g, '&');
const conn = base.replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });

const mem = JSON.parse(readFileSync('D:/_cm_export/memories.json', 'utf8'))[0];
const convUuid = 'claudeai-memory-snapshot-20260621';

const blocks = [];
if (mem.conversations_memory) blocks.push('[Claude.ai conversations_memory]\n' + mem.conversations_memory);
const pm = mem.project_memories;
if (pm) {
  if (typeof pm === 'string') blocks.push('[Claude.ai project_memories]\n' + pm);
  else if (Array.isArray(pm)) pm.forEach((x, i) => blocks.push('[project_memory ' + i + ']\n' + (typeof x === 'string' ? x : JSON.stringify(x, null, 2))));
  else Object.entries(pm).forEach(([k, v]) => blocks.push('[project_memory ' + k + ']\n' + (typeof v === 'string' ? v : JSON.stringify(v, null, 2))));
}

const now = new Date().toISOString();
const client = await pool.connect();
try {
  const exists = (await client.query('select 1 from conversations where uuid=$1', [convUuid])).rowCount;
  if (exists) { console.log('SNAPSHOT_ALREADY_PRESENT (delete from conversations where uuid=' + JSON.stringify(convUuid) + ' to reload)'); }
  else {
    await client.query('begin');
    try {
      await client.query('insert into conversations(uuid,name,project_uuid,created_at,updated_at,message_count) values($1,$2,$3,$4,$5,$6)',
        [convUuid, 'Claude.ai Memory Snapshot (export 2026-06-21)', null, now, now, blocks.length]);
      let ti = 0;
      for (const b of blocks) {
        await client.query('insert into messages(conversation_uuid,turn_index,sender,text,created_at) values($1,$2,$3,$4,$5)',
          [convUuid, ti++, 'assistant', b, now]);
      }
      await client.query('commit');
      console.log('LOADED snapshot: ' + blocks.length + ' blocks. REVERT: delete from messages where conversation_uuid=' + JSON.stringify(convUuid) + '; delete from conversations where uuid=' + JSON.stringify(convUuid) + ';');
    } catch (e) { await client.query('rollback'); console.error('ERR', e.message); }
  }
} finally { client.release(); await pool.end(); }
