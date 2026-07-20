import { Pool } from 'pg';
import { randomUUID } from 'crypto';
const raw = (await import('fs')).readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('NO_NEON_STRING'); process.exit(1); }
const conn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });
const now = new Date().toISOString();
const uuid = randomUUID();
const name = 'HAIR GROK GATE 2026-06-22 — shell-hair method FAILS R2 8.5 gate across whole roster (hair ~3, incl. Troy-approved Ironbraid POC, confound resolved); DECISION PENDING from Troy: waive vs strand/card rebuild';

const content = `BIG SISTER — CALDMERE — HAIR SPRING-BONE ROSTER — R2 GROK >=8.5 GATE QA — 2026-06-22 (two scheduled rule-reread runs) — HONEST.

ENV: 100% TRAINING ENV (Blender 5.1.2 headless + D:/_dem). Did NOT enter Unity (R1). VERIFICATION of already-built rig work, not new building. Rules served: R2 (Grok is the judge, >=8.5 or it doesn't count, never call my own output good), R3 (check motion not one frame), honesty (don't present FAIL as DONE).

WHY THE GATE WAS RUN: the roster docs (ROSTER_STATUS.md, PUNCH_LIST.md) had marked the 4 hair-spring BIPEDS "DONE"/"swing verified", but NO Grok >=8.5 score had ever been recorded for any biped (only the 2 centaurs had a documented Grok number: 9/10). Per R2, "DONE" without a Grok score is unverified. So I ran the gate with a strict grok-4-1-fast-reasoning AAA-MMO art-director ship/no-ship prompt.

RESULT — EVERY spring-hair character FAILS the 8.5 gate; the single blocker is the HAIR (primary source: Grok judgments this run):
 - Crimson Nightblade (M): overall 6.4, hair 3.2 -> FAIL
 - Forest Orc (F): overall 4.5, hair 3.1 -> FAIL
 - Peakbound (F): overall 5.4, hair 3.8 -> FAIL
 - Ironbraid (CONTROL — the POC Troy personally approved per HAIR_ANIM_PROOF.md): hair 3.2 on the swing render -> FAIL, identical to the others.

METHOD-LEVEL FINDING (not per-character): the Troy-approved Ironbraid POC scores hair the SAME (~3.2) as the "failing" bipeds. Grok is NOT rating the new characters worse — it rejects the ENTIRE luminance-shell hair method the same way every time. Consistent verdict: "solid, clumped geometry, no real strand separation or individual 3D strands; reads as a single deformed shell with some spring-bone motion rather than believable hair. Prescription: full strand/hair-card rebuild." This is consistent with how the method works: it fuses hair into one shell by basecolor luminance then spring-rigs the shell. The shell MOVES (the spring-bone secondary motion is real, and that motion is what Troy validated) — but as a SILHOUETTE it is a solid mass, not strands, so it fails an AAA hair-realism bar.

CONFOUND RESOLVED (2nd scheduled run, PM): the first Ironbraid control used Ironbraid_hair_swing.png, a desaturated/near-wireframe render — its low TEXTURE numbers (2.8-3.9) were a render artifact, not the asset. I removed the confound by re-running the gate on the already-existing, properly-lit/textured Ironbraid_FINAL_front.png (relight_ironbraid.py, Standard view). Result: hair STILL = 3 — Grok: "one solid, helmet-like shell with broad painted clumps and zero visible strand separation or volume; replace with multi-layer strand cards/curves plus flyaway wisps." So the shell-hair method fails the gate INDEPENDENT of render quality. Finding is now airtight, not confounded. The 3 biped swing renders were already properly textured (Grok PBR 5.2-8.1) — their failure was likewise genuinely the hair.

CORRECTED STATUS: the 4 spring-rigged bipeds are NOT done — rig + body + textures built; HAIR-REALISM GATE NOT CLEARED. I propagated this correction into ROSTER_STATUS.md and PUNCH_LIST.md (which still falsely said "DONE"/"swing verified"). Centaurs are UNAFFECTED — they passed Grok 9/10 (CENTAUR_ANIM_QA.md).

DECISION REQUIRED FROM TROY (NOT decided unilaterally — R5 / RULE ABOVE EVERYTHING; I did NOT start a rebuild and did NOT waive the gate):
 - OPTION A: accept the shell-hair method as the agreed bar for now (Troy's POC approval overrides the 8.5 gate for hair specifically, because the MOTION is what he validated; Unity Magica Cloth + a proper hair shader may close the visual gap later). Mark hair "approved-by-Troy, gate-waived," move on.
 - OPTION B: hold the 8.5 gate -> next training-env job = rebuild hair as cards/strands for the roster (real novel job, needs his go-ahead + chosen technique: hair cards from textured planes vs Blender particle/curve hair converted to mesh).

ARTIFACTS (R6, all on disk):
 - Biped swing renders: D:/_dem/meshy_fix/roster/Nightblade_swing.png, ForestOrc_swing.png, Peakbound_swing.png
 - Ironbraid control (swing, confounded): D:/_dem/meshy_fix/Ironbraid_hair_swing.png ; clean textured re-test: D:/_dem/meshy_fix/Ironbraid_FINAL_front.png
 - Doc: D:/_dem/meshy_fix/HAIR_GROK_GATE_QA_2026-06-22.md
 - Local memory: project_2026-06-22_hair_grok_gate_fails_method.md`;

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
