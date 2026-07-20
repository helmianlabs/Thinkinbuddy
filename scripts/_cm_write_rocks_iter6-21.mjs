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
const name = 'ROCKS iter6-21 2026-06-21 — Big Sister training env (REAL fracture geometry; climbed Grok 6.4->8.4; PLATEAUED below the 8.5 gate; NOT done)';

const content = `BIG SISTER — CALDMERE ROCKS (PUNCH_LIST Step 3) — iter6-21 — HONEST, NO SPIN — 2026-06-21 (scheduled rule-reread run)

ENV: 100% TRAINING ENV (Blender 5.1.2 HEADLESS, E:/blender/blender.exe --background --python, + D:/_dem/sandbox). Did NOT enter the Unity editor (R1). Did NOT use the live Blender-MCP scene — it currently holds Cloud Code's Ironbraid hair character, so building rocks there would collide with Troy's live work. Each rock_iterN.py is fully self-contained (builds its own suns/camera/ground/rocks, renders, exits) and touches nothing live.

GROK IS THE JUDGE (R2, grok-4-1-fast-reasoning). Every score is Grok's. Grok's NUMBER is noisy (±0.4-0.6 on near-identical images); its QUALITATIVE themes are consistent — steer by themes.

STATUS — HONEST: ROCKS ARE NOT DONE. Climbed from Grok 6.4 (iter6) to a stable 8.3-8.4 band on BOTH the wide and the close-up (peak 8.4 each), but NEVER a clean simultaneous 8.5. Plateaued. The OLD displaced-icosphere method (iter1-5) capped ~6.7; iter6 switched to REAL fracture geometry and climbed.

TRAJECTORY (Grok hero / low):
 iter6  6.4 / 6.8  REAL fracture geometry: Voronoi-bisect a cube with many planes + a geological joint set (flat faces, sharp arrises) instead of displaced spheres. Failure mode flipped from "blobby" to "too geometric/pyramidal."
 iter7  6.9 / 7.4  de-pyramid (equant base, oblique top, corner-shave cuts) + MESO undulation + deeper embed + de-tile color.
 iter8  7.2 / 7.6  push mid-freq displacement hard; round the worn pebbles; more bevel.
 iter9  7.4 / 7.4  weld+dissolve slivers; soften box projection_blend.
 iter10 7.5 / 7.8  kill the diagonal specular SEAM (a ROTATED 2nd box projection had its own diagonal axis-seam) -> scale-only + coord dither; facet-bowing displacement band; many more cuts.
 iter11 7.4 / 8.0  OBLIQUE faceted crown (no flat mesa top); rake the key light; crisper normal.
 iter12 7.7 / 7.7  dedicated FACE-CHIP cut pass; denser pebble skirt; flatter ground.
 iter13 7.8 / 8.0  EEVEE-NEXT Fast GI AO + shadows wired CORRECTLY (had been a silent no-op for 4 iters); finer subdivision; lower sky ambient.
 iter14 7.6 / 8.2  punchier directional light; matte roughness floor; warmer ground; more scatter.
 iter15 7.9 / 8.3  EDGE_SPLIT 26->46deg to SMOOTH-shade the bowed facets (flat-shading was the persistent "low-poly facet" read); softer terminator.
 iter16 8.2 / 8.4  GROUND relief geometry + multi-layer material + deeper crevice AO + warm the blue boulder (+0.3 on both).
 iter17 8.4 / 8.3  fix skirt floaters (camera-facing only); contact-zone gravel clusters.
 iter18 8.4 / 8.2  reject scattered-pebble floaters; settling tilt on small rocks.
 iter19 8.4 / 8.3  ground photoscan AO map + gravel-speck albedo; Fast GI distance 0.45.
 iter20 8.3 / 8.4  procedural sky gradient (too subtle); break the blue-boulder specular BANDING (roughness micro-noise).
 iter21 8.4 / 7.8* Light-Path-gated sky (vivid sky for camera rays, dim ambient for lighting -> atmosphere AND contrast kept). *low = Grok noise on a clean close-up; iter16/19/20 close-ups were 8.4/8.3/8.4.

WHY IT PLATEAUS BELOW 8.5 (Grok's consistent #1, last ~8 iters): the GROUND reads as a "flat shader" + the contact AO is soft. Both are environment/scene-context that overlap the NEXT deliverable (PUNCH Step 4 DIRT) and EEVEE engine limits — NOT the rock geometry/material (whose remaining Grok gripes are minor: faint banding, slight tiling, per-rock variation). Doing the dirt deliverable properly is the shared lever that lifts the rock-scene score too.

6 HARD-WON LEARNINGS (don't relearn):
 1. EEVEE in Blender 5.1 = EEVEE-NEXT. use_gtao/gtao_distance DO NOT EXIST (EEVEE-Legacy only) -> my iter9-12 AO was silently swallowed by try/except; contact AO was OFF for 4 iters while Grok flagged "no contact shadow" every time. Use ee.use_fast_gi + fast_gi_distance + use_shadows. Fast GI distance 0.35 + high quality = FULL BLACKOUT (over-occludes). Safe = distance 0.45-0.6, ray 4, step 8, quality 0.5.
 2. Flat-shaded facets read "low-poly" no matter how much you break them; the fix is SHADING (EDGE_SPLIT ~46deg keeps real arrises sharp while bowed facets smooth-shade as continuous stone).
 3. A ROTATED 2nd box projection adds its own diagonal axis-seam (reads as a bright specular streak). De-tile by SCALE only, never rotation. Dither the sampling coord to break clean box seams.
 4. Decouple the visible sky from the ambient (Light-Path Is-Camera-Ray): a bright sky as plain world ambient flattens contrast; gate it so the camera sees a vivid sky and lighting sees a dim ambient.
 5. Low ambient + strong key CLIPS/posterizes the close-up (lit faces fill frame) while the wide looks fine. Moderate key + ambient + lower exposure.
 6. Sink rocks by r*0.20 + 0.04m absolute (fraction-only sink floats small rocks on ground bumps). Keep skirt/scatter pebbles on the CAMERA-FACING hemisphere (behind-boulder fragments project onto the silhouette as floaters).

FINAL RECIPE = rock_iter21.py (most complete); rock_iter19.py = clean artifact-free fallback. Builders rock_iter6.py..rock_iter21.py in D:/_dem/sandbox/. Renders rock_iterN_a.png (hero) / _b.png (close). Best to show Troy = rock_iter21_a.png (wide, atmospheric, 8.4) + rock_iter21_b.png / rock_iter16_b.png (close, 8.4). Full doc + trajectory table + final recipe: E:/UnityProjects/Caldmere_v2/_design/ROCK_IMPLEMENTATION.md.

REMAINING LEVERS TO CROSS 8.5: (1) GROUND/DIRT — true high-res displacement (Displace modifier off Ground037 displacement map, or a real 4K scanned soil material) + matched albedo + denser pebble scatter = the next deliverable, lifts the rock SCENE too; (2) sharper contact AO (Cycles bake or baked AO decal — EEVEE Fast GI tops out soft); (3) minor rock polish (per-rock UV-scale variation, curvature-masked roughness, iron-oxide tri-planar masks); (4) if 8.5 still won't come procedurally, import a real high-poly rock sculpt/scan for the hero boulder (Grok's repeated suggestion).

NOT DONE / HONEST: rocks at Grok ~8.3-8.4, BELOW the 8.5 gate. No Unity work (R1, Cloud Code owns the editor). The rock ASSET itself is strong; the gate is held by the ground/dirt + engine AO limits — recommend doing the DIRT deliverable next, which is the shared limiter.`;

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
