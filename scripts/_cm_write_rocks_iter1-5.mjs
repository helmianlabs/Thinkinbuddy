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
const name = 'ROCKS iter1-5 2026-06-21 — Big Sister training env (best iter3 Grok 6.7, NOT at 8.5 gate; next = Cell Fracture)';

const content = `BIG SISTER — CALDMERE ROCKS (PUNCH_LIST Step 3) — IN PROGRESS, NOT DONE — 2026-06-21 (scheduled rule-reread run) — HONEST, NO SPIN

ENV: 100% TRAINING ENV (Blender 5.1.2 + D:/_dem). Did NOT enter the Unity editor (R1). Rocks built in an isolated RockLab collection at x=+20; the finished grass (GrassField_v19 / Ground_v19) and the character (char1 / Armature) were never touched, never deleted, .blend never saved.

GROK IS THE JUDGE (R2, grok-4-1-fast-reasoning). Every score below is Grok's.

STATUS — HONEST: ROCKS ARE NOT DONE. Best = iter3 @ Grok 6.7 (hero) / 6.4 (low). Below the R2 8.5 gate. My iter4 and iter5 "angular facet" attempts REGRESSED.

TRAJECTORY (hero / low):
 iter1  2.7 / 4.1  noise.cell() spikes + planar DECIMATE -> "explosively crystalline/spiky, exploded crystal clusters."
 iter2  ~2.x (near-black)  over-smoothed potatoes AND the weathering shader over-darkened to near-black.
 iter3  6.7 / 6.4  *** BEST *** brighter material + DEDICATED SUN rig + light fracture shaves + subsurf. Grok: reads as real stone, but "overly blobby/convex, single-scale noise, clean edges, mono albedo, pebbles look like clones."
 iter4  5.4 / 5.7  REGRESSED. Dropped subsurf, 4-5 hard facets, mineral-noise zones, raking 18deg sun. Grok: "artificial color banding" + "rubbery/plastic, melted clay." Roughness was backwards.
 iter5  4.3 / 4.7  REGRESSED further. Crisp flat facets applied last + subtle minerals + corrected roughness. Grok: "brain-fold procedural noise, blobby, no real planar facets, clay-like edges."

KEY LEARNING #1 (reusable, cost ~2 dark iterations): the live grass scene's Key/Fill/Rim are AREA lights at the ORIGIN. The RockLab sits at x=+20, so inverse-square falloff renders the rocks NEAR-BLACK. Grass renders worked only because grass sits inside those lights. FIX (now in render_rock.py): spawn dedicated SUN lights (directional, distance-independent: warm key + cool fill + cool rim), bump sky ambient, render, then delete the suns + restore the world. Any sandbox element built away from the origin must bring its own suns. Diagnosed by INSPECTING light types (not guessing) per BASE_RULES.

KEY LEARNING #2: the displaced-icosphere + multi-octave-noise + plane-shave method PLATEAUS ~6-7. Grok consistently reads it as "blobby / brain-fold noise / clay-like." Faking angular facets with shaves+noise added new artifacts (banding, clay edges) faster than realism -> LOWER scores. The cleaner, smoother, simpler-material iter3 beat both "fancier" later iters.

NEXT METHOD (Grok-directed, the real fix for 8.5): REAL angular FRACTURE geometry, not displaced spheres. Use Blender Cell Fracture (object_fracture_cell addon; enable it, or Voronoi-bisect a base mesh with planes) -> genuine flat-faced chunks + sharp arrises. Then light bevel (5-15cm radius, near-zero on fresh fractures), erode only exposed faces. Geological hierarchy as DISTINCT masked layers (one 60-70deg joint set + meso facets + micro grain), NOT one high-freq noise. Low-contrast mineral breakup (high-contrast mineral noise read as "banding"). Per-rock unique silhouettes + a few detached angular fragments at bases. Keep the dedicated-sun rig; ~25-30deg sun read better than an 18deg rake.

ARTIFACTS (all on disk, D:/_dem/sandbox/): builders rock_iter1.py..rock_iter5.py; render render_rock.py (TAG per iter, dedicated suns, hides grass/char from render, never saves .blend); renders rock_iterN_a.png (hero) / _b.png (low); best to show Troy = rock_iter3_a.png / rock_iter3_b.png. Photoscans Rock058/, Rock060/, Ground037/. Full doc + trajectory + iter3 recipe + NEXT-RUN PICKUP: E:/UnityProjects/Caldmere_v2/_design/ROCK_IMPLEMENTATION.md. PUNCH_LIST Step 3 -> IN PROGRESS; also fixed the stale grass entry there (grass IS done 8.7).

NOT DONE / HONEST: rocks below the 8.5 gate (best 6.7). No Unity work (R1, Cloud Code owns the editor). Stopped iterating after iter4-5 regressed rather than gamble more unsupervised; documented the clear next method for the next run.`;

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
