// Batch-scoped loader for the 2026-06-22 Claude.ai export (batch0000).
// Identical safe logic to _cm_load.mjs (additive + dedup-by-uuid + transaction + revert file),
// but reads from the extracted subfolder so it does NOT clobber the D:/_cm_export root.
// Flags: --dry-run = compute + report, NO writes.
import { Pool } from 'pg';
import { readFileSync, readdirSync, writeFileSync } from 'fs';

const DRY = process.argv.includes('--dry-run');
const dir = 'D:/_cm_export/claudeai_batch0000';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('NO_NEON_STRING'); process.exit(1); }
const base = m[0].replace(/\\u0026/g, '&');
const conn = base.replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 3 });

function msgText(msg) {
  if (msg.text && msg.text.trim()) return msg.text;
  const c = msg.content;
  if (Array.isArray(c)) {
    const parts = [];
    for (const b of c) {
      if (!b) continue;
      if (typeof b === 'string') parts.push(b);
      else if (typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.join('\n');
  }
  return '';
}

const convs = JSON.parse(readFileSync(dir + '/conversations.json', 'utf8'));
const pfiles = readdirSync(dir + '/projects');

const client = await pool.connect();
try {
  const exConv = new Set((await client.query('select uuid from conversations')).rows.map(r => r.uuid));
  const exProj = new Set((await client.query('select uuid from projects')).rows.map(r => r.uuid));

  let projNew = 0, projBad = 0; const newProjUuids = [];
  for (const f of pfiles) {
    let p;
    try { p = JSON.parse(readFileSync(dir + '/projects/' + f, 'utf8')); }
    catch (e) { projBad++; console.error('PROJ_PARSE_FAIL', f, e.message); continue; }
    if (!p.uuid || exProj.has(p.uuid)) continue;
    projNew++; newProjUuids.push(p.uuid);
    if (!DRY) await client.query('insert into projects(uuid,name,raw) values($1,$2,$3)', [p.uuid, p.name || '', JSON.stringify(p)]);
  }

  let convNew = 0, convSkip = 0, msgIns = 0, msgEmpty = 0;
  const newConvUuids = [];
  for (const c of convs) {
    if (exConv.has(c.uuid)) { convSkip++; continue; }
    const msgs = Array.isArray(c.chat_messages) ? c.chat_messages : [];
    convNew++; newConvUuids.push(c.uuid);
    if (!DRY) {
      await client.query('begin');
      try {
        await client.query('insert into conversations(uuid,name,project_uuid,created_at,updated_at,message_count) values($1,$2,$3,$4,$5,$6)',
          [c.uuid, c.name || '', c.project_uuid || null, c.created_at || null, c.updated_at || null, msgs.length]);
        let ti = 0;
        for (const mm of msgs) {
          const t = msgText(mm);
          if (!t || !t.trim()) { ti++; msgEmpty++; continue; }
          await client.query('insert into messages(conversation_uuid,turn_index,sender,text,created_at) values($1,$2,$3,$4,$5)',
            [c.uuid, ti, mm.sender || '', t, mm.created_at || null]);
          msgIns++; ti++;
        }
        await client.query('commit');
      } catch (e) { await client.query('rollback'); console.error('CONV_ERR', c.uuid, e.message); }
    } else {
      for (const mm of msgs) { const t = msgText(mm); if (t && t.trim()) msgIns++; else msgEmpty++; }
    }
  }

  console.log(JSON.stringify({ mode: DRY ? 'DRY' : 'LIVE', projectsInExport: pfiles.length, projNew, projBad, convsInExport: convs.length, convNew, convSkip, msgIns, msgEmpty }, null, 2));
  if (!DRY) {
    writeFileSync(dir + '/_loaded_uuids.json', JSON.stringify({ batch: 'claudeai_batch0000', newConvUuids, newProjUuids }, null, 2));
    console.log('REVERT saved -> ' + dir + '/_loaded_uuids.json');
  }
} finally { client.release(); await pool.end(); }
