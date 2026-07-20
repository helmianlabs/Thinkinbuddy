// Write Big Sister's locked Caldmere operating rules into Neon claude_memory.
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('NO_NEON_STRING'); process.exit(1); }
const conn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });
const now = new Date().toISOString();
const uuid = randomUUID();
const name = 'RULES (LOCKED 2026-06-21) — Big Sister Caldmere operating rules';
const rules = `BIG SISTER — CALDMERE OPERATING RULES (LOCKED 2026-06-21 by Troy). Re-read every ~20 min.
R1 STAY IN TRAINING ENV (Blender + D:/_dem). Do NOT enter the Unity editor (Cloud Code owns it for character creation; no agents in editor). No Unity without Troy's explicit permission; then do EXACTLY what he says.
R2 GROK 8.5+ ON EVERYTHING before it counts (grass, rocks, dirt, shrubbery, trees, materials), each separately. Trust Grok; never call my own output good.
R3 CHECK EVERY ANIMATION of a rigged character with Grok, not just idle.
R4 DOCUMENT every success in a well-named MD (E:/UnityProjects/Caldmere_v2/_design/). Fill it, move on.
R5 DO NOT BE INDEPENDENT. Do what Troy says step by step; learn each mistake, never repeat it.
R6 SCREENSHOTS = downloadable file + clickable link/path, never a dead card. Common-sense framing.
R7 SHORT BURSTS; check Troy's messages constantly; respond fast + short; never head-down 5-10 min.
R8 VOICE short (~30s), never interrupt him; stop cold on "stop".
R9 NO billboard/flat-photo grass — real blade GEOMETRY + wind shader + photoscans.
R10 PLANNING MARKERS first in Unity (blue=river, distinct colors per element), then build.
R11 RE-READ rules + MD + memory every ~20 min (scheduled).
R12 PERSIST to Neon claude_memory.
Canonical: E:/UnityProjects/Caldmere_v2/_design/BIG_SISTER_OPERATING_RULES.md ; mirror ~/.claude/.../memory/feedback_2026-06-21_caldmere_operating_rules.md`;
const c = await pool.connect();
try {
  await c.query('begin');
  await c.query('insert into conversations(uuid,name,project_uuid,created_at,updated_at,message_count) values($1,$2,$3,$4,$5,$6)', [uuid, name, null, now, now, 1]);
  await c.query('insert into messages(conversation_uuid,turn_index,sender,text,created_at) values($1,$2,$3,$4,$5)', [uuid, 0, 'assistant', rules, now]);
  await c.query('commit');
  const r = await c.query('select count(*)::int n from messages where conversation_uuid=$1', [uuid]);
  console.log(JSON.stringify({ wrote: 'OK', uuid, readBack: r.rows[0].n }));
} catch (e) { await c.query('rollback'); console.error('ERR', e.message); process.exit(1); }
finally { c.release(); await pool.end(); }
