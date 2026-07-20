import { Pool } from 'pg';
import { randomUUID } from 'crypto';
const raw = (await import('fs')).readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('NO_NEON_STRING'); process.exit(1); }
const conn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });
const now = new Date().toISOString();
const uuid = randomUUID();
const name = 'CENTAUR ANIM QA 2026-06-22 #2 — Forest Centaur all 20 anims PASS (Grok 9/10, R2 8.5 gate cleared, R3 every-anim); montage death1 FAIL was a false positive';

const content = `BIG SISTER — CALDMERE — FOREST CENTAUR PER-ANIMATION SKINNING/TEARING QA — 2026-06-22 (scheduled rule-reread run) — HONEST.

ENV: 100% TRAINING ENV (Blender 5.1.2 headless + D:/_dem). Did NOT enter Unity (R1). VERIFICATION of already-built rig (the centaur rig transfer from 2026-06-21), not new building. Rule served: R3 (check EVERY animation, not just idle) + R2 (Grok is the judge, >= 8.5). This completes the Forest Centaur QA that the Midnight Centaur QA doc listed as "still owed".

PRIMARY SOURCES (verified this session, not memory):
 - ForestCentaur_rigged.blend -> armature Centaur_rig = 127 bones; mesh Mesh0 = 37,086 verts skinned across 127 vertex groups (enumerated via headless bpy). NOTE: this is a DIFFERENT mesh from Midnight (214,919 verts) -> auto-weighted separately, so re-QA was genuinely required, not assumable from Midnight's pass.
 - 20 actions, all 20 rendered distinctly, 20/20 UNIQUE render md5 hashes (cleaner than Midnight's 19/20) -> every action genuinely drives the mesh. Frames sampled at 55% of each action's range. Actions: attack1/2/3, bat_idle_trick, battle_idle, death1, defence_start/end, hit1/2, idle1, idle1_look_around, idle1_to_idle2, idle2, idle2_to_idle1, run, turn_left_arm, turn_right_arm, walk1, walk2.

GROK VERDICTS (grok-4-1-fast; Grok is the judge, R2):
 - Contact sheet (all 20 anims, ~384px/cell, 55%-range frame): FIRST PASS = 19 clean / 1 flagged. Grok flagged cell 6 death1 as "exploded/detached horse body floating away from human-waist seam" -> initial montage verdict FAIL 7/10.
 - FULL-RES RE-CHECK of the flagged death1 (this is the point of R3 — verify the flag, do not ignore it): Grok = CLEAN 9/10. My own eyes on the full-res frame agreed: intact, fully connected centaur in a valid dramatic horizontal FALL/collapse pose. The "explosion" was a FALSE POSITIVE caused by the tiny 384px montage cell — at cell scale a dramatic falling centaur reads as floating chunks.
 - Full-res on the 3 other most deformation-extreme anims (attack1, attack3, run): CLEAN 9/10 each. Waist<->withers seam, shoulders, elbows, neck, hips, knees, hocks all deform clean.

VERDICT: Forest Centaur skinning/tearing QA = PASS (Grok 9/10, clears the R2 8.5 gate) across all 20 animations. Gate cleared BECAUSE the montage FAIL flag was full-res-verified, not ignored. No re-rig needed for skinning.

HONEST LIMITATIONS (not hidden): one representative ~55%-range frame per anim for the montage + 4 anims at full res; did NOT render every frame of every anim. Lesson reinforced: the 384px montage can produce false-positive "explosion" flags on dramatic horizontal poses (death/fall) — always full-res-verify a montage flag before reporting a FAIL.

ARTIFACTS (R6, all on disk):
 - Contact sheet: D:/_dem/meshy_fix/roster/qa_anim_forest/_MONTAGE.png
 - 20 full-res per-anim renders: D:/_dem/meshy_fix/roster/qa_anim_forest/anim_*.png
 - Scripts: D:/_dem/meshy_fix/qa_render_all_forest_centaur.py, qa_montage_forest.py
 - Doc: E:/UnityProjects/Caldmere_v2/_design/CENTAUR_ANIM_QA.md (mirror in D:/_dem/meshy_fix/)

STATE OF THE REST OF THE WORK (verified this run, for the next session):
 - HAIR spring-bone rollout (Troy's priority) is BLOCKED with no unblocked target left: 6 done (Ironbraid, Nightblade, Forest Orc, Peakbound, Midnight + Forest Centaur). Remaining: Lirael + Elven Ranger = BLONDE -> need the new hue-based segmentation heuristic, EXPLICITLY HELD for Troy (do NOT freelance, per HAIR_RIG_WORKFLOW.md). Malakar = bald, Orc Fighter = hooded (no hair). Winged Harpy + Aris Theron = NO source FBX staged in roster_src or Assets/MeshyImports (cannot process).
 - ROCKS (Grok 6.7) + DIRT (Grok 6.7) below the 8.5 gate; blocker for both = lighting/contact-AO + scene context (Cycles AO bake, distant terrain/sky) -> pipeline changes that need Troy's call (R5).
 - WATER v5 applied live, needs Troy's editor walk.
 - Open rig additions (both centaurs + bipeds): finger bones for weapon grip + weapon socket (NOT tearing defects). Bipeds need a Mixamo anim set before their per-anim tearing QA can run.`;

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
