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
const name = 'GRASS DONE 2026-06-21 — Big Sister training env (Grok 8.7 mid-distance, cleared R2 8.5 gate, iter14->19)';

const content = `BIG SISTER — CALDMERE GRASS — DONE (Grok >= 8.5) — 2026-06-21 (scheduled rule-reread run) — HONEST, NO SPIN

ENV: 100% TRAINING ENV (Blender 5.1.2 + D:/_dem). Did NOT enter the Unity editor (R1). A 1.7m character mesh "char1" was present in the shared Blender scene and rendered into the FIRST grass shot by mistake; I hid all char* meshes from render (hide_render=True), never deleted them, never saved the .blend (character work belongs to Cloud Code).

GROK IS THE JUDGE (R2, grok-4-1-fast-reasoning). Every score below is Grok's, not mine. My own eye was WRONG twice this run (I thought iter15 looked bad -> Grok 7.8 up; I thought iter18 still looked pale -> Grok 8.6 pass). Trusting Grok over my own judgment is exactly R2 and it paid off.

FULL TRAJECTORY (this run, iter14->19, picking up from iter13 @ 6.4):
 iter14  7.3  Wider bases (+~50%) + hold-width-then-taper profile + base flare + per-blade width-mult + AgX tonemap. KILLED the "thin/spiky" read. New flaws: too tall/isolated w/ soil gaps; "paddle" silhouette; too yellow.
 iter15  7.8  Shorter blades (-25%), greener, tripled short under-layer, gradual taper. Helped; soil gaps persisted (under-layer was 1.2-3cm AND lying flat -> occluded nothing at the camera angle).
 iter16  8.3  *** 5-12cm denser MOSTLY-UPRIGHT under-layer (~72k blades) *** + aggressive width variation + 30 small clusters w/ per-cluster green/straw bias. Grok: "crossed the believable dense turf threshold." This under-layer fix was the single biggest jump.
 iter17  8.4  2nd ultra-short (2-6cm) fill layer + 90 small clusters + per-blade value/hue jitter + ~7% kinked blades + fully-random lean (local chaos). One flaw left: pale/washed-out gray-green cast (over-lit) + over-compressed value range.
 iter18  8.6  *** CLEARED 8.5 (mid-distance) *** richer EMERALD + saturation up; cut sheen 0.40->0.22, cut bright translucency 1.4->1.12, lowered rim+skylight; AgX *Base* contrast + lower exposure. Pale cast resolved. Close-up cross-check = 7.4 (blades looked agave/sword up close).
 iter19  8.7 (mid) / 7.7 (close-up)  *** FINAL *** width VARIATION fix: capped wmul 1.95->1.3, narrowed bases ~17%, more thin 'fine' blades, wider edge notches. Mid-distance 8.7 (Grok: YES >=8.5, NO regression). Close-up 7.7 (up from 7.4).

STATUS — HONEST: Grass PASSES the R2 gate (Grok 8.7) at the in-game ground-cover viewing distance, which is the actual use case for a Unity terrain detail mesh. The near-ground EXTREME close-up is 7.7 (not the 8.0 stretch target) — a few broad parallel-sided blades still read up close. This is the inherent tension: mid-distance wants broad blades (to not read thin/spiky), close-up wants narrow blades. The element COUNTS as done for ground cover; the close-up can be nudged to 8.0+ later (more thin foreground blades) only if Troy wants FPS-close fidelity.

KEY LESSONS (6.4 -> 8.7):
 1. UNDER-LAYER HEIGHT/POSTURE is what closes soil gaps: a 5-12cm MOSTLY-UPRIGHT under-layer occludes ground at a look-down camera; a 1-3cm LYING-FLAT layer does not. (iter15->16 = +0.5.)
 2. The pale/washed-out cast came from sheen + bright translucency + cool skylight + AgX Medium-High contrast all stacking. Fix = richer saturated vertex colors + lower sheen/translucency/rim + AgX *Base* contrast + lower exposure. (iter17->18 = the final 0.2.)
 3. Width is a TWO-DISTANCE tradeoff: solve it with VARIATION (mostly medium, few wide, few thin) + a cap on max width, not by uniformly widening or narrowing.
 4. ALWAYS verify the render before scoring — the first iter14 render framed a hidden character's hair, not grass. A 5-second look caught it (R6 spirit: look at the artifact).
 5. Trust Grok over my own eye (R2) — confirmed twice this run.

ARTIFACTS (all on disk):
 - FINAL builder: D:/_dem/sandbox/grass_iter19.py  (also grass_iter14..18.py)
 - Render setup: D:/_dem/sandbox/render_grass.py  (AgX Base, dual-camera mid+close)
 - FINAL renders: D:/_dem/sandbox/grass_iter19_a.png (8.7 mid hero), grass_iter19_b.png (7.7 close-up)
 - Full recipe + iteration log + final recipe: E:/UnityProjects/Caldmere_v2/_design/GRASS_IMPLEMENTATION.md ("FINAL RECIPE" section)

NEXT ELEMENT = ROCKS (PUNCH_LIST Step 3): same proven loop — build offline in D:/_dem/sandbox/, photoscans already cached (Rock058/, Rock060/), render hero + 2nd angle, Grok-score, iterate to >= 8.5 before it counts. Then DIRT (Step 4).

NOT DONE / HONEST: wind shader NOT built (engine-side, deferred to Unity per R1). NOT deployed to Unity (Cloud Code owns the editor; needs Troy's explicit permission per R1). Renders are on disk; I surfaced downloadable files + clickable paths to Troy in chat (R6).`;

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
