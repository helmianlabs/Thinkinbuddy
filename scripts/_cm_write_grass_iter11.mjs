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
const name = 'GRASS iter11 progress 2026-06-21 — Big Sister training env (folded-V -> morphology overhaul, PENDING Grok)';

const content = `BIG SISTER — CALDMERE GRASS PROGRESS — 2026-06-21 — HONEST, NO SPIN

ENV: Stayed 100% in TRAINING ENV (Blender + D:/_dem). Did NOT enter the Unity editor (R1). Character meshes in the Blender scene (char1.009 etc, missing-texture magenta) were HIDDEN from render only, never deleted, .blend never saved.

GOAL: Grass blade geometry to Grok Vision >= 8.5 (R2) before it ships. Real blade mesh + photoscan + wind (R9); wind shader is engine-side.

ITERATION LOG (Grok grok-4-1-fast-reasoning scores):
 iter5  6.5  flat ribbons (pre-existing)
 iter6  6.7  folded-V crease (raised midrib, 2 lit faces), taper-to-point, per-blade variation, clumps
 iter7  7.4  sharper taper, cross-section variety, twist, height clusters, dry blades, soil+litter+pebbles, backlit translucency -> Grok: "reads as reeds, not turf"
 iter8/9     framing experiments (worm's-eye / isolated clump) -> regressions, not scored
 iter10 7.8  big frame-filling patch, ~7400 blades, darker soil, messier lean -> Grok: "still reeds; blade MORPHOLOGY is the core issue — straight extruded cards, little taper/twist/width-variation, need multiple blade types"
 iter11 PENDING  MORPHOLOGY OVERHAUL (below). Rendered grass_iter11_a.png. Grok could NOT score it — xAI Grok vision API returned HTTP 503 (connection refused) on 4 retries across grok-4-1-fast-reasoning AND grok-4. NOT certified. NOT claimed done.

iter11 RECIPE (D:/_dem/sandbox/grass_iter11.py):
 - 4 blade TYPES: lawn 45% (broad), fine 25% (thin+longer+more twist), young 18% (short upright), arch 12% (recurve)
 - broad base -> sharp taper width=w*(1-t^1.2)^0.8 (~43% width at 70% length, point tip)
 - HELICAL twist: cross-section rotates around the tangent (Rodrigues) so the face turns -> kills flat-card read
 - irregular edge notches (per-ring width jitter) + centerline wiggle -> chaotic micro-silhouette
 - low-amplitude S tip bend; cross-section variety (V / strong-V / cupped)
 - color: 30% ochre/straw, 25% desat olive, 45% green; 3-stop base->mid->tip gradient in vertex color "Col" (alpha=height t)
 - material: Principled (rough .48, sheen .40, subsurface .12 green) MIX Translucent BSDF tinted by blade's own color, weighted by Col.alpha (tips transmit more)
 - distribution: 6 cluster archetypes, tufts 4-8 sharing a base + thatch litter, bare-patch negative space, ~3200 young fill; ~9700 blades / 269k verts
 - ground Ground103 photoscan x dark brown; render EEVEE softened skylight + warm key + cool rim, mid-distance cam

ARTIFACTS (all on disk):
 - Builders: D:/_dem/sandbox/grass_iter6.py .. grass_iter11.py
 - Render setup: D:/_dem/sandbox/render_grass.py
 - QA renders: D:/_dem/sandbox/grass_iter6_a.png .. grass_iter11_a.png
 - Doc (full recipe + log): E:/UnityProjects/Caldmere_v2/_design/GRASS_IMPLEMENTATION.md
 - Punch list updated: E:/UnityProjects/Caldmere_v2/_design/PUNCH_LIST.md (STEP 2 = IN PROGRESS, iter11 PENDING Grok)

NEXT-RUN PICKUP:
 1. Retry Grok on D:/_dem/sandbox/grass_iter11_a.png (analyze_image). Build is live in Blender scene GrassLab5 object GrassField_v11; re-render via render_grass.py if needed.
 2. If < 8.5: more blade-type variety + finer fescue, less uniform wind-lean, richer base thatch (no bare dirt between blades), add a 2nd lower close-up QA angle.
 3. After 8.5: ROCKS (Step 3) -> DIRT (Step 4) per PUNCH_LIST.md.

NOT DONE / HONEST: iter11 NOT Grok-verified (API outage). Wind shader not built (engine-side, deferred to Unity). No Unity editor work. No screenshots sent to Troy (standing order).`;

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
