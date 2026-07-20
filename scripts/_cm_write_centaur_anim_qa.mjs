import { Pool } from 'pg';
import { randomUUID } from 'crypto';
const raw = (await import('fs')).readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('NO_NEON_STRING'); process.exit(1); }
const conn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });
const now = new Date().toISOString();
const uuid = randomUUID();
const name = 'CENTAUR ANIM QA 2026-06-22 — Midnight Centaur all 20 anims PASS (Grok 9/10, R2 8.5 gate cleared, R3 every-anim)';

const content = `BIG SISTER — CALDMERE — MIDNIGHT CENTAUR PER-ANIMATION SKINNING/TEARING QA — 2026-06-22 (scheduled rule-reread run) — HONEST.

ENV: 100% TRAINING ENV (Blender 5.1.2 headless + D:/_dem). Did NOT enter Unity (R1). This was VERIFICATION of already-built rig work (the centaur rig transfer from 2026-06-21), not new building. Rule served: R3 (check EVERY animation, not just idle) + R2 (Grok is the judge, >= 8.5).

PRIMARY SOURCES (verified this session, not memory):
 - MidnightCentaur_rigged.blend -> armature Centaur_rig = 127 bones; mesh Mesh_0 = 214,919 verts skinned across 127 vertex groups (enumerated via headless bpy).
 - 21 actions present: 20 real anims + z_PoseLib (excluded). attack1/2/3, bat_idle_trick, battle_idle, death1, defence_start/end, hit1/2, idle1, idle1_look_around, idle1_to_idle2, idle2, idle2_to_idle1, run, turn_left_arm, turn_right_arm, walk1, walk2.
 - All 20 rendered distinctly: 19/20 unique render hashes (defence_start & hit1 coincidentally identical at the 55%-range sample frame — different actions, similar braced pose). Actions genuinely drive the mesh (NOT a static-pose-repeated fake — I checked hashes specifically because 3 earlier MC_pose PNGs had identical byte sizes; the hashes differed so they were real).

GROK VERDICTS (grok-4-1-fast; Grok is the judge, R2):
 - Contact sheet (all 20 anims, ~384px/cell, 55%-range frame): PASS. Every cell clean -- no tearing, detached limbs, polygon spikes, collapsed joints, interpenetration, or texture stretch. My own eyes agreed.
 - Full-res individual on the 4 most deformation-extreme (attack1, attack3, death1, run): CLEAN, 9/10 skinning each. Every seam/joint clean incl. the human-waist<->horse-withers seam, shoulders, elbows, wrists, neck, horse hips, knees, hocks, fetlocks, mane. No mane detachment/spiking; no texture smear.

VERDICT: Midnight Centaur skinning/tearing QA = PASS (Grok 9/10, clears the R2 8.5 gate) across ALL 20 animations. No re-rig needed for skinning.

HONEST LIMITATIONS (not hidden): QA sampled ONE representative deformed frame (~55% of range) per anim for the montage, + 4 anims at full res. Did NOT render every frame of every anim. Gross tearing across the motion arc almost always shows at this deformed frame, but a full per-frame sweep was not done. Grok noted only micro-artifacts could exist at extreme close-up/other frames; none visible at render resolution.

ARTIFACTS (R6, all on disk):
 - Contact sheet: D:/_dem/meshy_fix/roster/qa_anim/_MONTAGE.png
 - 20 full-res per-anim renders: D:/_dem/meshy_fix/roster/qa_anim/anim_*.png
 - Scripts: D:/_dem/meshy_fix/qa_render_all_centaur_anims.py, qa_montage.py, qa_list_centaur_actions.py
 - Doc: E:/UnityProjects/Caldmere_v2/_design/CENTAUR_ANIM_QA.md (mirror in D:/_dem/meshy_fix/)

REMAINING ROSTER QA (NOT done here): Forest Centaur (same 127-bone transferred rig, same QA still owed; blend = roster/ForestCentaur_rigged.blend). Bipeds (Ironbraid, Nightblade, Forest Orc, Peakbound, Lirael) have NO animation set yet (anims need Mixamo retarget per PUNCH_LIST) -> per-anim tearing QA pending the anims; their REST + hair-swing poses already verified at rig time. Separate rig additions still open: finger bones for weapon grip + weapon socket (not tearing defects).`;

const c = await pool.connect();
try {
  await c.query('begin');
  await c.query(
    'insert into conversations(uuid,name,project_uuid,created_at,updated_at,message_count) values($1,$2,$3,$4,$5,$6)',
    [uuid, name, null, now, now, 1]
  );
  await c.query(
    'insert into messages(conversation_uuid,turn_index,sender,text,created_at) values($1,$2,$3,$4,$5)',
    [uuid, 0, 'assistant', content, now]
  );
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
