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
const name = 'SESSION HANDOFF 2026-06-21 — Caldmere Big Sister full day honest audit';

const content = `BIG SISTER SESSION HANDOFF — 2026-06-21 — HONEST, NO SPIN

TROY'S RULES (re-read every session):
R1 Stay in training env (Blender + D:/_dem). No Unity without explicit permission.
R2 Grok 8.5+ on EVERYTHING before it counts.
R3 Check EVERY animation, not just idle.
R4 Document every success in MD at E:/UnityProjects/Caldmere_v2/_design/
R5 Do NOT be independent. Do what Troy says step by step.
R6 Screenshots = real catbox.moe URL, NEVER a local path.
R7 Short bursts, check messages constantly.
R8 Voice EVERY response. & "C:\\Users\\troyh\\.claude\\speak.ps1" -Who bigsister -Text "..."
R9 No billboard grass — real blade geometry + wind shader + photoscans.
R10 Planning markers first in Unity (blue=river, distinct colors per element).
R11 Re-read rules + MD + memory every ~20 min.
R12 Persist to Neon claude_memory.

WHAT WAS ACTUALLY DONE TODAY (verified):
1. PUNCH_LIST.md written — E:/UnityProjects/Caldmere_v2/_design/PUNCH_LIST.md
2. MIGRATION_PLAN_V1_TO_V2.md written — lists all 108 scripts to port
3. MASTER_TRAINING_REFERENCE.md written — full game vision, races/classes, systems
4. 108 combat/gameplay scripts copied from Caldmere v1 → Caldmere_v2/Assets/Scripts/
   (Combat, Player, World, UI_Game, Skills, Loot, EconomyGameplay, Quests, Net, Enemies, Progression, Generated, Vfx, Sfx)
5. Netcode for GameObjects 2.12.0 added to Caldmere_v2/Packages/manifest.json
6. Meshy bridge_start operator called in Blender — server thread started on port 9876
   [UNVERIFIED: Troy says menu not showing like YouTube — bridge may not be fully working]
7. 8 humanoid FBXs re-exported to _MixamoUpload/TPose/ with rest pose applied
   [UNVERIFIED: render camera was wrong, pose not visually confirmed by Grok]
8. Memory files written: feedback_voice_every_response, feedback_mixamo_tpose_requirement
9. Operating rules written to BIG_SISTER_OPERATING_RULES.md + Neon DB + MEMORY.md

WHAT THE 3 AGENTS DID (READ ONLY — they built NOTHING in Unity):
- Agent 1: Audited all scripts in Caldmere_v2 — found what exists
- Agent 2: Audited all scripts in Caldmere v1 — found 207 real scripts, zero stubs
- Agent 3: Read all design docs, wrote MASTER_TRAINING_REFERENCE.md

WHAT IS NOT DONE / VERIFIED (honest):
- Billboard grass in Unity: claimed stripped last session, Troy saw it still there. [UNVERIFIED]
- Nothing assembled in Unity — no buildings, trees, mobs, XP, HUD wired
- 108 scripts copied to disk but NOT wired in editor (Unity needs to compile them)
- Mixamo T-pose re-export: attempted but NOT visually verified
- Meshy→Blender bridge: started but Troy says not showing correctly in Blender UI
- Grass, rocks, dirt, shrubbery, trees: NONE at Grok 8.5+ yet (grass stuck at 6.5/10)
- Grok Vision: service was 503 errors all day, couldn't score renders
- Wind shader: not built
- All-animation QA on centaurs: not completed
- Cloud Code character creation work: unknown state (they were in the editor all day)

CALDMERE_V2 ACTUAL STATE (verified by agent audit this session):
- Project: E:/UnityProjects/Caldmere_v2/
- Unity 6 URP 17.4.0, Linear color space, MapMagic procedural terrain
- MCP bridge: com.ivanmurzak.unity.mcp 0.81.0 (LOCKED — do NOT update to 0.82.1)
- Character creation: BUILT by Cloud Code (all 10 races, Supabase auth) — gap: nextSceneName=""
- Combat/gameplay scripts: 108 files NOW in Assets/Scripts/ (not yet wired)
- NO buildings, trees, mobs placed in any scene
- Scenes: SampleScene.unity, StarterZone.unity
- StylizedWater.shader + StylizedWaterfall.shader: real URP shaders
- MicroSplat define set but package NOT installed (dead define)
- NatureStarterKit2 shaders: Legacy/Built-in, will show pink in URP

KEY FILES:
- E:/UnityProjects/Caldmere_v2/_design/PUNCH_LIST.md
- E:/UnityProjects/Caldmere_v2/_design/MIGRATION_PLAN_V1_TO_V2.md
- E:/UnityProjects/Caldmere_v2/_design/MASTER_TRAINING_REFERENCE.md
- E:/UnityProjects/Caldmere_v2/_design/BIG_SISTER_OPERATING_RULES.md
- E:/UnityProjects/Caldmere_v2/_design/RACE_CLASS_CANON.md
- E:/UnityProjects/Caldmere_v2/_MixamoUpload/TPose/ (8 FBXs — unverified T-pose)
- D:/_dem/sandbox/ (AmbientCG photoscan materials: Grass001, Rock058/060, Ground037/103)

WHAT NEW SESSION SHOULD DO FIRST:
1. Re-read this handoff + BIG_SISTER_OPERATING_RULES.md
2. Verify Meshy bridge is actually working in Blender (Troy said menu wrong)
3. Verify T-pose on the 8 Mixamo FBXs with Grok
4. When editor is free: wire the 108 scripts (CharCreationController nextSceneName, combat setup)
5. Training env: get grass to Grok 8.5+ BEFORE touching Unity terrain

WHAT NOT TO REPEAT:
- Do NOT call local paths "clickable links"
- Do NOT skip voice on any response
- Do NOT claim something is done without Grok or Troy verifying it
- Do NOT go head-down for 5+ minutes without checking messages
- Do NOT enter Unity editor without Troy's explicit go-ahead
`;

const messages = [
  { turn: 0, sender: 'assistant', text: content }
];

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
} catch(e) {
  await c.query('rollback');
  console.error('ERR', e.message);
  process.exit(1);
} finally {
  c.release();
  await pool.end();
}
