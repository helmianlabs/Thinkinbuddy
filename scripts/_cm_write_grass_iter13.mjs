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
const name = 'GRASS iter12-13 progress 2026-06-21 — Big Sister training env (Grok 4.8 -> 5.3 -> 6.4, soil solved, morphology next)';

const content = `BIG SISTER — CALDMERE GRASS PROGRESS — 2026-06-21 (scheduled rule-reread run #2) — HONEST, NO SPIN

ENV: Stayed 100% in TRAINING ENV (Blender + D:/_dem). Did NOT enter the Unity editor (R1). Character meshes in the Blender scene (char1.009, missing-texture magenta) were HIDDEN from render only, never deleted, .blend never saved.

GROK IS THE JUDGE (R2, grok-4-1-fast-reasoning). xAI vision API is back up (was 503 last run). Scores are honest; I did NOT call my own output good.

ITERATION LOG (this run):
 iter11  4.8  Re-scored the previously-uncertified morphology-overhaul render. Grok: "density too low — large areas of bare muddy ground break the continuous turf illusion." REGRESSION vs iter10 (7.8): the render FRAMING was the cause — 1.3m grass patch << 3.2m ground plane, shallow ~26deg look saw PAST the grass to a bare-mud horizon (top ~40% of frame). The morphology work was being masked by bad framing.
 iter12  5.3  Framing fix: 2.4m patch, ~2.5x density, short under-layer, +20% wider bases, steeper 54deg camera. Grok: "still too much visible bare mud; canopy never forms a truly continuous turf layer." Steep top-down maximizes visible soil; near-black mud makes every gap a high-contrast hole. Modestly better than 4.8.
 iter13  6.4  MOSSY ground (green-brown multiply + green moss floor mix, so residual soil reads as moss not dirt) + dense ground-hug LAX/splayed under-layer (9000 short young blades, ~40% near-horizontal bend) + wider bases + moderate 43deg camera. Grok: soil/continuity flaw SOLVED (no longer mentions bare mud). New #1 flaw: "blades remain too uniformly thin/spiky — insufficient base width + organic width variation along length." (The original iter10 reed read, resurfacing now density is fixed.) Beats 5.3. ~31k blades / 828k verts.

KEY LESSONS (took 4.8 -> 6.4):
 1. FRAME MUST BE ALL CANOPY: the grass patch must exceed the camera frustum (>=2.4m) so no bare-ground OR sky horizon shows. This single framing bug cost ~3 points.
 2. MOSSY green-brown ground, NOT near-black mud — residual inter-blade soil then reads as moss. Killed the "bare mud" complaint outright.
 3. DENSE ground-hug LAX/splayed under-layer (near-horizontal short blades) physically covers soil.
 4. Wider blade bases. Morphology is now the remaining blocker (still slightly reed-like).
 5. iter13 framing artifact: moderate angle blew the SKY background WHITE between upper blade tips — fix next (steeper angle / taller back-row / lower world bg strength / Filmic-AgX view transform).

ARTIFACTS (all on disk):
 - Builders: D:/_dem/sandbox/grass_iter11.py, grass_iter12.py, grass_iter13.py
 - Render setup: D:/_dem/sandbox/render_grass.py (camera now 43deg, OUT=grass_iter13_a.png)
 - QA renders: D:/_dem/sandbox/grass_iter11_a.png (4.8), grass_iter12_a.png (5.3), grass_iter13_a.png (6.4 = current best)
 - Doc (full recipe + log + iter14 plan): E:/UnityProjects/Caldmere_v2/_design/GRASS_IMPLEMENTATION.md

NEXT-RUN PICKUP — iter14 (Grok's exact fix list for 6.4 -> 8.5):
 1. WIDEN BASES MORE + true width-taper along length so blades read as broad grass not thin spikes (bump lawn/young base widths ~30-50%, steepen broad-base profile, more width variation).
 2. Even denser/shorter/more-horizontal under-layer to remove last gaps + true mat.
 3. More local clumping + subtle random lean directions; less uniform spike orientation.
 4. Fix the white-sky framing artifact (steeper cam / taller back-row / lower world bg / Filmic view transform).
 5. Re-score Grok; add a 2nd lower close-up QA angle once >= 8.0.
 6. After 8.5: ROCKS (Step 3) -> DIRT (Step 4) per PUNCH_LIST.md.

NOT DONE / HONEST: grass is NOT at 8.5 (best = 6.4). NOT shipped. Wind shader not built (engine-side, deferred to Unity, R1). No Unity editor work. Renders are on disk for Troy to open; I will surface the downloadable file + path in chat (R6).`;

const messages = [{ turn: 0, sender: 'assistant', text: content }];

const c = await pool.connect();
try {
  await c.query('begin');
  await c.query(
    'insert into conversations(uuid,name,project_uuid,created_at,updated_at,message_count) values($1,$2,$3,$4,$5,$6)',
    [uuid, name, null, now, now, messages.length]
  );
  for (const msg of messages) {
    await c.query(
      'insert into messages(conversation_uuid,turn_index,sender,text,created_at) values($1,$2,$3,$4,$5)',
      [uuid, msg.turn, msg.sender, msg.text, now]
    );
  }
  await c.query('commit');
  const r = await c.query('select count(*)::int n from messages where conversation_uuid=$1', [uuid]);
  console.log(JSON.stringify({ wrote: 'OK', uuid, messages: r.rows[0].n }));
} catch (e) {
  await c.query('rollback');
  console.error('ERR', e.message);
  process.exit(1);
} finally {
  c.release();
  await pool.end();
}
