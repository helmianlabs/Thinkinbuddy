// One-off: write a ~28h Caldmere handoff into the shared Neon claude_memory DB.
// Connection derived from .claude.json exactly like _cm_load.mjs (swap /neondb -> /claude_memory).
// Additive: creates ONE new conversation + messages. Saves the uuid for revert.
import { Pool } from 'pg';
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('NO_NEON_STRING'); process.exit(1); }
const conn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/claude_memory$1');
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 3 });

const now = new Date().toISOString();
const convUuid = randomUUID();
const convName = 'HANDOFF 2026-06-21 — Caldmere v2: terrain/water/materials/characters + the offline-render lesson (Big Sister, ~28h)';

const M = [];
const push = t => M.push(t);

push(`# CALDMERE_V2 HANDOFF — last ~28 hours — written ${now} by Big Sister (terminal Claude).
Project: E:/UnityProjects/Caldmere_v2 (the OLD E:/UnityProjects/Caldmere is ABANDONED). Offline training env: D:/_dem/.

TWO SUPREME GATES on every claim below (Troy's rules 0.001/0.002):
1) SOURCE OF TRUTH — cite the primary source (file:line / API / DB). 2) CITE OR SHUT UP — no cite, no claim.
Stamps: [VERIFIED: file] checked this session; [UNVERIFIED] carried from prior notes, not re-checked.

🔴 TROY'S EMPHATIC STANDING ORDERS (this session, restate to any next Claude):
- NO MORE SCREENSHOTS sent to Troy. He judges visuals in the LIVE Unity editor himself. Render ONLY for silent self-QA.
- STOP CHEERLEADING. Never call output "good / real / photorealistic / done / 8.5" on my own say-so.
- TRUST GROK VISION, not my own eye. If Grok scores it low, it IS low — fix it, don't argue the tool is wrong.
- DON'T act on my own / don't freelance. Execute what Troy (and Coach, when Troy relays him) say, step by step. When unsure, STOP and ask.
- Workflow: Agents = parallel RESEARCH only. Big Sister WRITES + OWNS the code (don't delegate terrain code). Coach (cloud Claude, via Troy copy-paste) REVIEWS, I fix + resubmit. QA = GROUND TRUTH (live editor / eye-level), never top-down.`);

push(`## THE BIG LESSON THIS SESSION (offline rendering) — do NOT repeat my mistake.
I built an OFFLINE Node raymarch renderer (D:/_dem/sandbox/render3d.mjs) to make "beautiful" golden-hour terrain+water screenshots as a gate to entering Unity. [VERIFIED: D:/_dem/sandbox/render3d.mjs exists]
RESULT: garbage. v1 = flat, hazy, washed-out, one camera missed the water entirely. v2 (golden hour, ACES, shadows) = OVEREXPOSED to near-white, banded water reflections, bleached. I wrongly presented these to Troy with hedged-but-still-cheerleading captions → he was (rightly) furious.
CONCLUSION (honest, now proven across materials AND terrain): a hand-rolled Node raymarcher CANNOT produce AAA-looking imagery. Beauty comes from Unity's actual URP renderer (real PBR, shadows, post, AA, detail meshes). The OFFLINE env is for MATH ONLY — terrain shape, hydrology, water-in-channel geometry, material PARAMETER values — NOT for final visuals. Verify visuals in Unity, score with Grok Vision. STOP trying to make pretty pictures offline.`);

push(`## TERRAIN PIPELINE (all in D:/_dem/) [VERIFIED: files present in D:/_dem]
- proc_terrain.mjs — parameterized 6x6km procedural generator (~8min). Composition: ~60% flat valleys + 3 broad ranges + rolling foothills + ~6 ISOLATED organic mesas (NO global terrace). Coach fixes baked in (mesa rim warp, flat-top jitter). Run: node --max-old-space-size=4096 D:/_dem/proc_terrain.mjs -> proc_terrain.r16 + hillshade/oblique png.
- Brush learning scripts: learn_terrain.mjs, learn_terrain2.mjs, learn_brushfix.mjs. Value->effect notes in _design/TERRAIN_TOOL_NOTES.md (low noise-freq=rolling, high=spiky; smooth WEAK on spikes-fix at source; flatten 0.9=flat valley; terrace only rare mesas).
- ground_render2.cs — eye-level manual-camera QA shots. apply_proc_neutral.cs — load proc onto Caldmere_TriState w/ neutral grey clay. smooth_buttes2.cs — strong valley-masked smooth that melts buttes into hills.
- Refs: ref/ground/ (Idaho/Nevada eye-level photos), ref/mmorpg_terrain/, ref/video_njaQmkOeTgg/ (Ashes of Creation chargen video = in-game look target).
- Live terrain meta [VERIFIED: D:/_dem/sandbox/live_meta.json]: res 2049, size 6000x600x6000m. Peak ~401m at (4160,1230). Range ~397m (real relief, NOT flat).`);

push(`## WATER SYSTEM (Caldmere "Thousand Springs/Crater Lake" model) — evolved v1->v5.
DESIGN (Troy+Coach, locked): CRATER LAKE = endorheic, NO outflow (precip/spring fed), wide plateau top + contained sunken dip + central island. RIVER starts from a SPRING carved on the mountainside (~310m elev) -> basin-biased meandering descent -> SUNKEN BASIN LAKE (surface BELOW valley floor so river flows DOWN into it).
IN-ENGINE (build_water.cs v4) [UNVERIFIED in live editor this session]: flood-fill lakes (BFS, only where terrain submerged -> NO floating sheets), Cull Off shaders, river split into FLAT REACH strips on benches + 2 WATERFALL cascades over terrace risers + Mist particles. Shaders: Assets/Shaders/StylizedWater.shader + StylizedWaterfall.shader (URP HLSL). Mountain TERRACED (terrace_mountain.cs, 55m benches). Pipeline order: restore_heights -> terrace_mountain -> carve_water2 -> build_water -> render. Backup heights_pre_water.f32 (restore_heights.cs).
RECURRING COMPLAINT + FIX: flat water meshes OVERHANG the carved terrain at edges/drops -> water must nestle INTO the cut. Lakes clip to terrain<level-0.6; river surface = bed+0.7 following the gutter, strips narrowed.`);

push(`## OFFLINE WATER SANDBOX (the math proof — this DOES work) [VERIFIED: D:/_dem/sandbox/]
Purpose: prove the river sits DOWN in a carved ditch (banks above water) BEFORE touching Unity.
- export_heights.cs -> live_heights.raw (2049^2 float32) + live_meta.json. Crash-safe: arrays never cross the bridge, only summary strings.
- route.mjs — steepest-descent routing + MONOTONIC water surface (never uphill) + freeboard. SELF-VERIFY metrics last run: 0 uphill segments, channel "not-a-ditch" 0/77, cascade float 0.00m. Writes water_plan_v5.json (crater/spring/basin + 77-pt river w/ ySurf/yFloor/width/mode). [VERIFIED: route.mjs logic + water_plan_v5.json present]
- carve_sim.mjs, xsection_plot.mjs (cross-sections proving banks above water), viz.mjs (top-down). These cross-section / number proofs are VALID and clear. The 3D "beauty" renders are NOT (see big lesson).`);

push(`## MATERIALS — procedural FAILED, real photoscans are the path. [VERIFIED: D:/_dem/sandbox/]
- material_lab.mjs (hand-rolled fbm procedural PBR) scored progressively WORSE on Grok (7.2 -> 6.3 -> 5.2 -> 3.2). My edits made it blurrier; Grok was right. Honest conclusion: crude noise + crude renderer can't do photoreal.
- SWITCHED to real CC0 AmbientCG photoscans (download: https://ambientcg.com/get?file=<ID>_1K-JPG.zip ; API ids: https://ambientcg.com/api/v2/full_json?type=Material&q=<term>). Downloaded sets: Ground103 (dry dirt), Ground037, Rock058, Rock060, Grass001, PavingStones046/141 — each has Color/NormalGL/NormalDX/Roughness/AO/Displacement JPG + a preview .png.
- Real-asset palette (decoded from preview PNGs this session): dirt 137/117/89, rock 112/105/98, grass 67/84/48.
- URP authoring rules (from D:/_dem/_learn/pbr_materials_maps.md): metallic=0 for natural surfaces; smoothness = 1 - roughness; use NormalGL (Y+); sRGB ON for color, OFF for data maps (metallic/AO/rough/height); TerrainLit MaskMap RGBA = R metallic, G AO, B height, A smoothness; max 4 layers/pass.
- VERIFY materials IN UNITY in-scene (same material reads flat in an isolated ball preview, fine in scene). Grass = detail-mesh blades, NOT a flat swatch.
- 6 expertise docs in D:/_dem/_learn/: urp_shader_graph.md, pbr_materials_maps.md, uv_unwrapping_tiling.md, unity_terrain_brushes.md, wind_grass_particles.md, urp_lighting.md.`);

push(`## GOOGLE EARTH -> UNITY terrain pipeline (Troy's vision) [VERIFIED: reference memory file]
Principle: DEM = bones, Vision = skin. Pull REAL elevation (USGS 3DEP/SRTM DEM GeoTIFF) for the lat/long -> heightmap (NOT extract from screenshots). Google Earth screenshots + Grok Vision guide the VISUAL layer only (where vegetation clusters, water color, erosion style). D:/_dem/node_modules has geotiff/lerc/pako/float16 DEM decoders. Same pipeline already built Caldmere_TriState (real ID/NV/UT DEM, 6km).
Honest accuracy: terrain shape very high; river+channel high w/ light cleanup; vegetation ~70%; underwater bathymetry weakest (DEM can't see it). Overall "real place -> Unity, 1-2 passes" ~75-85%.
Full doc: C:/Users/troyh/.claude/projects/C--Users-troyh--claude/memory/reference_2026-06-21_google_earth_to_unity_terrain_pipeline.md.`);

push(`## RACE / CLASS / PROGRESSION CANON [VERIFIED: E:/UnityProjects/Caldmere_v2/_design/RACE_CLASS_CANON.md, locked 2026-06-21]
10 RACES: Aracoix (bird-folk; "Aracoix" = coined Shadowbane name, Troy to confirm keep/rename), Centaur, Dwarf, Elf, Half Giant, Human, Minotaur, Orc, Shade (dark, approved), Vampire (dark).
4 BASE CLASSES (chargen): Fighter, Mage, Healer, Rogue.
LEVEL-10 PROMOTIONS (lvl 10 = class promotion + guild creation + PvP flag, all together):
  Fighter -> Warrior (hybrid Crusader = Fighter+Healer); Healer -> Priest (hybrid Druid = nature/arcane); Rogue -> Thief, Scout; Mage -> dark+light variants TBD.
SKILLS: weapon training independent of class (train by use); stealth detection = Rogue+Mage ONLY; Thief steals from players+NPCs; Scout->Tracking (costs resources); Healer->Summons+Resurrection; chain/pull skill-line (Dragonknight-style, name TBD).
WORLD/PVP/GUILD: starter zone all-levels; PvP flagged from lvl10, open-world, guild-vs-guild; guild at lvl10 (buy Charter, emblem, Siege Stone+city); crafting only via guild city OR Safehold vendor (3-4 Safeholds); 8 organic zones following ID/NV/UT topo = guild territory; NO factions (old 3 factions -> mob types/quests).
GEAR: ALWAYS CLOTHED. Starter gear: Fighter=plate, Mage=cloth robes, Rogue=leather, Healer=robes/vestments. Seamless swaps (never an undressed state). No nudity/hide-slot. Family-friendly.
CHARGEN per race M+F: appearance sliders (hair/eyes/nose/body), attributes (Strength/Constitution/Dexterity/Intelligence/Spirit +/-), class selector, SIGILS (drag-drop permanent passives), background/lore, name, Play.
OPEN TBD: Mage archetype names, chain skill-line name, poll-mechanic detail, Aracoix name confirm.`);

push(`## CHARACTERS + the Meshy pipeline [mixed VERIFIED/UNVERIFIED]
PROVEN CHEAP PIPELINE: Gemini image -> Meshy (image-to-3D + auto-rig + animations) -> FBX -> Unity/Blender. Already imported: textured rigged Vampire in armor, Shade w/ walk+run anims. Chargen screens designed for all 10 races M+F (Gemini mockups = blueprint; rebuild as real Unity UI + hook sliders to customization code).
CENTAUR LIVE in StarterZone [UNVERIFIED in editor this session]: Player_Centaur = CGTrader centaur_cgt.fbx (Generic rig, 21 clips), valley floor (1594,5.4,2202), ~2.4m, neutral URP clay. Animator centaur.controller (Speed float -> Idle/Walk/Run; Attack/Hit/Death triggers). Third-person rig: ThirdPersonController.cs (WASD+Shift), ThirdPersonCamera.cs (follow/RMB orbit/scroll), CameraModeSwitch.cs (press V -> FlyCam). ⚠️ Use centaur_cgt.fbx NOT the Meshy centaur.fbx (imports lying down, needs +90X). Controller bugs to fix later: not flush to ground (needs raycast/SampleHeight snap), clunky movement + stalls when camera orbited, clay-on-clay hard to read.
Meshy texture binding fix: D:/_dem/bridge/apply_meshy_textures.cs (Meshy chars import untextured; bind meshy_basecolor/normal/metallic PNGs into a URP/Lit material).
🔴 TROY'S CURRENT BLOCKER (right now, 2026-06-21): Meshy -> Blender via THEIR PLUGIN is NOT working today — it worked yesterday. Something changed. He's stuck on characters. Diagnose the Meshy->Blender plugin connection (it was a set-up export bridge); NOT yet root-caused.`);

push(`## UNITY-MCP BRIDGE + current live Caldmere_v2 state.
BRIDGE [VERIFIED pattern]: from project dir, unity-mcp-cli run-tool script-execute --path "E:/UnityProjects/Caldmere_v2" --input '{"csharpCode":"public class Script{public static object Main(){...}}"}'. Works via CLOUD (ai-game.dev) even when local port 29339 refuses. Helper: node D:/_dem/bridge/run.mjs <code.cs>. Transient HTTP 401 right after a compile = domain-reload window, wait ~12s + retry (NOT the broken-plugin case).
BROKEN-PLUGIN FIX [VERIFIED: manifest edit this session]: MCP plugin auto-updating to 0.82.1 fails to compile (CS0234 'AgentConfig' / CS0103 McpServerChecksum) -> Play button greys out. Cause this session: com.ivanmurzak.unity.mcp.terrain in Packages/manifest.json forced 0.82.1 via transitive dep. FIX: removed that line from E:/UnityProjects/Caldmere_v2/Packages/manifest.json (revert = re-add). Pin plugin to 0.81.0. NEVER set colorSpace via the bridge (hangs the machine). Editor in PLAY MODE blocks SetHeights (set EditorApplication.isPlaying=false first).
LIVE STATE [UNVERIFIED this session, from prior notes]: StarterZone scene = Sun + Caldmere_TriState (6x6km) + FlyCam (press Play, WASD+RMB+scroll, FlyCamera.cs) + Player_Centaur + _DayNight (CaldmereDayNight.cs, 180s loop, sun+2 moons) + water system + textures applied zone-wide. Noon reads flat/pale (untextured-clay artifact -> textures, not more light).`);

push(`## OPEN BLOCKERS / NEXT QUEUE (as of handoff)
1) 🔴 Meshy->Blender plugin broken TODAY (Troy's active pain) — diagnose why the plugin export stopped working since yesterday.
2) Materials INTO Unity: author the real CC0 set as TerrainLayers w/ correct URP values (metallic 0, smoothness=1-roughness, NormalGL, sRGB rules); verify in-scene + Grok-score. Test on a small patch first.
3) Build the actual brushes that READ the plan masks (plan_river.u8 / plan_tree.f32 / plan_rock.u8 in D:/_dem/sandbox) to place water/trees/rocks.
4) Grass = detail-mesh blades + wind sway; Shader Graph water + grass/branch sway (in Unity); Wind Zones; falling-leaf particles; player graphics-quality toggle scaling effects.
5) Rocks/trees/shrubs scatter (copy prefab packages from the nested old project first, w/ deps/.meta).
6) Centaur controller polish (ground-snap + camera-orbit stall).
7) Per-race chargen UI from Gemini mockups, hook sliders to customization code.
DO NOT: send Troy screenshots, cheerlead, or trust my own visual judgment over Grok. Verify visuals in the live editor.`);

const client = await pool.connect();
try {
  await client.query('begin');
  await client.query(
    'insert into conversations(uuid,name,project_uuid,created_at,updated_at,message_count) values($1,$2,$3,$4,$5,$6)',
    [convUuid, convName, null, now, now, M.length]);
  for (let i = 0; i < M.length; i++) {
    await client.query(
      'insert into messages(conversation_uuid,turn_index,sender,text,created_at) values($1,$2,$3,$4,$5)',
      [convUuid, i, 'assistant', M[i], now]);
  }
  await client.query('commit');
  writeFileSync('D:/_dem/_cm_handoff_uuid.json', JSON.stringify({ convUuid, when: now, messages: M.length }, null, 2));
  // verify read-back
  const c = await client.query('select count(*)::int n from messages where conversation_uuid=$1', [convUuid]);
  console.log(JSON.stringify({ wrote: 'OK', convUuid, convName, messagesInserted: M.length, readBackCount: c.rows[0].n }, null, 2));
} catch (e) { await client.query('rollback'); console.error('WRITE_ERR', e.message); process.exit(1); }
finally { client.release(); await pool.end(); }
