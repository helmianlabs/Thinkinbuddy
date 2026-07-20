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
const name = 'DIRT PATHS iter1-3 2026-06-21 — Big Sister training env (real carved rut/footpath mesh; Grok hero 5.3->6.2->6.7, close ~6.1-6.3; BELOW the 8.5 gate; NOT done)';

const content = `BIG SISTER — CALDMERE DIRT PATHS (PUNCH_LIST Step 4) — iter1-3 — HONEST, NO SPIN — 2026-06-21 (scheduled rule-reread run)

ENV: 100% TRAINING ENV (Blender 5.1.2 HEADLESS, E:/blender/blender.exe --background --python, + D:/_dem/sandbox). Did NOT enter the Unity editor (R1). Did NOT use the live Blender-MCP scene (holds Cloud Code's character). Each dirt_iterN.py is fully self-contained (own suns/camera/ground/stones, renders hero _a + low close _b, exits) and touches nothing live.

GROK IS THE JUDGE (R2, grok-4-1-fast-reasoning). Every score is Grok's. Number is noisy ±0.4-0.6; steer by the consistent qualitative themes.

STATUS — HONEST: DIRT IS NOT DONE. Grok hero 5.3 -> 6.2 -> 6.7 (steady climb looking down the track); low close-up ~6.1-6.3 (plateau). Never near 8.5. Same engine ceilings the rocks hit (close-up micro-detail caps at mesh resolution; EEVEE contact AO is soft).

CONCEPT: worn medieval dirt cart-track — two parallel wheel ruts (gauge ~1.55m) with raised mud berms, worn central footpath, bare compacted soil flanked by mossy shoulders, embedded fieldstones + rut gravel. Real CARVED rut/footpath MESH geometry, not a flat normal-mapped plane (R9).

TWO PHOTOSCANS (picked by LOOKING at the previews first): Ground103 = bare warm compacted soil -> trodden PATH + ruts; Ground037 = mossy/green forest floor -> untrodden SHOULDERS. Stones = Rock058.

TRAJECTORY (Grok hero / low):
 iter1  5.3 / 5.4  baseline: 2-material X-band path/shoulder split, per-vertex ruts + footpath + clods, embedded stones, raking key + Light-Path sky + EEVEE-Next Fast GI + AgX (rock scaffolding). Grok: ruts read as flat normal-map lines; stones sit on top; dirt reads as flat wet-plastic/clay.
 iter2  6.2 / 6.3  (+0.9) DEEPER ruts + RAISED MUD BERMS on the outer edges + tread ripples; cracked-mud cells + erosion channels + grain (break the smooth ripples); WET/DRY roughness via mesh cavity (damp ruts glossier, dry crowns matte); stone PUSH-UP RINGS + settle pits; specular IOR 0.22->0.14.
 iter3  6.7 / 6.1  (hero +0.5) rut EROSION variation (lateral wobble + width var + washout scours — not a uniform V); PATCHY damp (noise-masked) -> killed the fake 'standing-water sheet' Grok flagged; softer grass margin + margin pebbles; 3-octave grain + denser 300-seg mesh; deeper stone embed (show ~44%) + base gravel; Fast GI 0.40->0.36. (low flat = Grok noise; close-up micro-detail is the wall.)

KEY LEARNINGS (don't relearn):
 1. Map Range shader node attr is interpolation_type, NOT interpolation (crashed iter1's first run).
 2. A CONTINUOUS damp/low-roughness rut bottom reads as a FAKE 'standing-water sheet' — patch-mask the damp with noise + keep the roughness drop subtle, or commit to real puddle pools only in the deepest spots.
 3. Geometric grain CAPS at the mesh resolution (~4cm at 300 seg over 12m). Close-up 1-4mm gravel/silt crispness CANNOT come from more verts — it needs a MATERIAL-side high-frequency detail normal + albedo overlay. Grok's #1 close-up note 3 iters running. THIS IS THE NEXT LEVER (iter4).
 4. EEVEE-Next Fast GI contact AO tops out soft -> stones still read slightly decal-like. Sharp contact needs a Cycles AO bake or a baked contact-shadow decal (same ceiling ROCK_IMPLEMENTATION.md hit).
 5. Two-photoscan path/shoulder split (bare Ground103 vs mossy Ground037) is the right structure — confirmed by looking at the source previews before building.
 6. Grok flip-flopped on ruts (iter2 'too uniform' -> iter3 'too organic, lacks cart compaction'). Target the MIDDLE: parallel compacted ruts with subtle erosion + periodic tire-lug imprints, not heavy wobble.

FINAL RECIPE = dirt_iter3.py (most complete). Builders dirt_iter1.py..dirt_iter3.py in D:/_dem/sandbox/. Renders dirt_iterN_a.png (hero) / _b.png (low close). Best to show Troy = dirt_iter3_a.png (hero 6.7) + dirt_iter2_b.png/dirt_iter3_b.png (close ~6.3). Full doc + trajectory + recipe + ranked next levers: E:/UnityProjects/Caldmere_v2/_design/DIRT_IMPLEMENTATION.md.

REMAINING LEVERS TO CROSS 8.5 (ranked, NEXT-RUN PICKUP): (1) MATERIAL high-freq detail normal + albedo overlay (1-4mm), 2-3 passes masked to non-rut flats + a gravel-scatter albedo map = the #1 close-up lever, do this FIRST (iter4); (2) sharper stone contact (Cycles AO bake or baked contact-shadow decal + deeper underside depression); (3) real grass<->dirt margin transition (15-20cm dead-grass + rootlets + soil-creep band, possibly graft grass_iter19.py blade geometry onto the shoulders); (4) firmer cart-compacted ruts (dial wobble back + periodic tire-lug imprints); (5) if 8.5 still won't come, sample a real high-res scanned dirt-displacement map per-vertex on an adaptive mesh.

NOT DONE / HONEST: dirt CLIMBING (hero 5.3->6.2->6.7) but BELOW the 8.5 gate. No Unity work (R1, Cloud Code owns the editor). Grass is done (8.7); rocks plateaued ~8.3-8.4 (the dirt is their shared ground-lever). Recommend continuing dirt iter4 = the material detail overlay.`;

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
