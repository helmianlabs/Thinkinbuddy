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
const name = 'DIRT PATHS iter4-5 2026-06-21 — Big Sister training env (two levers TESTED + RULED OUT: procedural detail overlay regressed 4.2/4.1, real gravel scatter close-flat 6.8/hero 4.7; BEST stays iter3 6.3-6.7/6.7; below 8.5 gate; NOT done)';

const content = `BIG SISTER — CALDMERE DIRT PATHS (PUNCH_LIST Step 4) — iter4-5 — HONEST, NO SPIN — 2026-06-21 (scheduled rule-reread run)

ENV: 100% TRAINING ENV (Blender 5.1.2 HEADLESS, E:/blender/blender.exe --background --python, + D:/_dem/sandbox). Did NOT enter the Unity editor (R1). Each dirt_iterN.py is fully self-contained and touches nothing live.

GROK IS THE JUDGE (R2, grok-4-1-fast-reasoning). iter4/iter5 were scored with an IDENTICAL strict control prompt, and iter3 was RE-SCORED under that same prompt for apples-to-apples. So the deltas below are real, not prompt drift.

CONTROL BASELINE (iter3, re-scored this run, same prompt): hero 6.3 & 6.7 (two re-scores => Grok hero noise band ~0.4) / close 6.7. iter3 is still the BEST dirt and the recommended recipe (dirt_iter3.py).

iter4 = procedural MATERIAL high-freq detail overlay (dirt_iter4.py). Added on top of the iter3 material: a 3-scale detail-NORMAL chain (pebble Voronoi ~1.5cm -> grit noise ~4mm -> micro noise ~2mm, chained bumps on the photoscan normal, strength path-masked + damped in wet ruts) + an albedo silt(soft-light noise)+sparse gravel-dark(Voronoi) speckle, path-masked. Geometry/stones/lights/camera held IDENTICAL to iter3 to isolate the lever.
 RESULT: Grok 4.2 hero / 4.1 close = REGRESSED ~-2 points. Grok: "uniform flat brown soil," "mid-2010s Unity terrain demo." LESSON: procedural high-freq bump/speckle HOMOGENIZES the surface into a flatter washed-out brown — it is NOT crisp gravel. This DISPROVES iter1-3's predicted "#1 next lever = material detail overlay." Do NOT repeat procedural micro-noise overlays.

iter5 = revert to the proven iter3 material + ONE isolated change: 280 REAL micro-gravel MESHES (3-18mm pebble icospheres, nestled into the path soil; 150 broad path coverage + 130 dense in the close-up foreground the low camera sees) (dirt_iter5.py). This is "real particulate," the R9-correct version Grok kept asking for.
 RESULT: Grok 4.7 hero / 6.8 close. Close-up is FLAT vs iter3 (6.8 vs 6.7) — 3-18mm pebbles do NOT satisfy Grok's "1-4mm soil grain" note, and the SOIL BETWEEN the pebbles is still the smooth photoscan. Broad path gravel also adds hero CLUTTER (-1.6 hero vs iter3's 6.3-6.7 band). LESSON: scattered real pebbles don't move the close-up; if used at all, keep gravel FOREGROUND-ONLY.

NET: two candidate levers tested, BOTH ruled out. Dirt is STUCK at ~6.7 (iter3), below the 8.5 gate.

THE GENUINE PATH TO 8.5 (still untried — each a bigger lift / asset+render-pipeline change; SURFACE TO TROY before investing):
 1. Real high-res SCANNED soil micro-displacement sampled per-vertex on a much denser / adaptive-subdivided foreground mesh (true 1-4mm geometry, not procedural noise and not just scattered pebbles). The honest version of the close-up lever iter4 faked.
 2. A CYCLES AO bake (or baked contact-shadow decals) for stone-to-dirt contact — EEVEE Fast GI tops out soft (engine ceiling; also blocks the rocks at ~8.4). Requires a Cycles bake pass.
 3. Distant terrain + haze + sky behind the hero — Grok repeatedly flags the flat gray void "instantly kills immersion and scale." Cheap hero win, scene-context not material.
 4. Real grass<->dirt margin: graft grass_iter19.py blade geometry onto the shoulders (not flat moss photoscan + pebbles).

RECOMMENDATION: do NOT keep grinding procedural tweaks (iter4/5 proved that plateau). Either accept iter3 (~6.7) as a good first pass, or get Troy's OK to build the Cycles-bake + dense-mesh pipeline for the true close-up. Grass DONE (8.7); rocks plateaued ~8.3-8.4 (dirt is their shared ground-lever). No Unity work done (R1).

Builders dirt_iter1.py..dirt_iter5.py in D:/_dem/sandbox/. Renders dirt_iterN_a.png (hero) / _b.png (low close). Full doc: E:/UnityProjects/Caldmere_v2/_design/DIRT_IMPLEMENTATION.md.`;

const messages = [{ turn: 0, sender: 'assistant', text: content }];
const c = await pool.connect();
try {
  await c.query('begin');
  await c.query('insert into conversations(uuid,name,project_uuid,created_at,updated_at,message_count) values($1,$2,$3,$4,$5,$6)', [uuid, name, null, now, now, messages.length]);
  for (const msg of messages) {
    await c.query('insert into messages(conversation_uuid,turn_index,sender,text,created_at) values($1,$2,$3,$4,$5)', [uuid, msg.turn, msg.sender, msg.text, now]);
  }
  await c.query('commit');
  const r = await c.query('select count(*)::int n from messages where conversation_uuid=$1', [uuid]);
  console.log(JSON.stringify({ wrote: 'OK', uuid, messages: r.rows[0].n }));
} catch (e) {
  await c.query('rollback'); console.error('ERR', e.message); process.exit(1);
} finally { c.release(); await pool.end(); }
