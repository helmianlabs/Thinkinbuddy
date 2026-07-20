// Load tonight's (2026-06-22) Claude.ai memories.json snapshot into Neon claude_memory.
// Reads the batch0000 subfolder (not the root). Idempotent by uuid; ALSO compares content
// against the prior 2026-06-21 snapshot and skips if byte-identical (no useless duplicate).
// Flags: --dry-run = compute + report, NO writes.
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const DRY = process.argv.includes('--dry-run');
const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
const conn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });

const mem = JSON.parse(readFileSync('D:/_cm_export/claudeai_batch0000/memories.json', 'utf8'))[0];
const convUuid = 'claudeai-memory-snapshot-20260622';
const prevUuid = 'claudeai-memory-snapshot-20260621';

const blocks = [];
if (mem.conversations_memory) blocks.push('[Claude.ai conversations_memory]\n' + mem.conversations_memory);
const pm = mem.project_memories;
if (pm) {
  if (typeof pm === 'string') blocks.push('[Claude.ai project_memories]\n' + pm);
  else if (Array.isArray(pm)) pm.forEach((x, i) => blocks.push('[project_memory ' + i + ']\n' + (typeof x === 'string' ? x : JSON.stringify(x, null, 2))));
  else Object.entries(pm).forEach(([k, v]) => blocks.push('[project_memory ' + k + ']\n' + (typeof v === 'string' ? v : JSON.stringify(v, null, 2))));
}
const newText = blocks.join('\n----\n');

const now = new Date().toISOString();
const client = await pool.connect();
try {
  const exists = (await client.query('select 1 from conversations where uuid=$1', [convUuid])).rowCount;
  const prev = (await client.query('select text from messages where conversation_uuid=$1 order by turn_index', [prevUuid])).rows;
  const prevText = prev.map(r => r.text).join('\n----\n');
  const identicalToPrev = prev.length > 0 && prevText === newText;

  const report = { mode: DRY ? 'DRY' : 'LIVE', blocks: blocks.length, newChars: newText.length, prevSnapshotBlocks: prev.length, identicalToPrev, alreadyPresentThisUuid: !!exists };

  if (exists) { report.action = 'SKIP_uuid_already_present'; }
  else if (identicalToPrev) { report.action = 'SKIP_identical_to_2026-06-21_snapshot'; }
  else if (!DRY) {
    await client.query('begin');
    try {
      await client.query('insert into conversations(uuid,name,project_uuid,created_at,updated_at,message_count) values($1,$2,$3,$4,$5,$6)',
        [convUuid, 'Claude.ai Memory Snapshot (export 2026-06-22)', null, now, now, blocks.length]);
      let ti = 0;
      for (const b of blocks) {
        await client.query('insert into messages(conversation_uuid,turn_index,sender,text,created_at) values($1,$2,$3,$4,$5)',
          [convUuid, ti++, 'assistant', b, now]);
      }
      await client.query('commit');
      report.action = 'LOADED';
      report.revert = "delete from messages where conversation_uuid='" + convUuid + "'; delete from conversations where uuid='" + convUuid + "';";
    } catch (e) { await client.query('rollback'); report.action = 'ERR:' + e.message; }
  } else { report.action = 'WOULD_LOAD'; }

  console.log(JSON.stringify(report, null, 2));
} finally { client.release(); await pool.end(); }
