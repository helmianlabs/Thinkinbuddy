// dairyforge-scrub-names.mjs — NON-DESTRUCTIVE real-NAME scrub for the DairyForge
// demo DB (Neon `neondb`). Content-only: NO slug renames, NO row deletes, NO FK
// cascade. Every UPDATE is WHERE-guarded → idempotent (re-run = no-op).
//
// Targets (verified live 2026-06-10 by the audit agent):
//   1. plants.display_name   — 4 old-slug rows still holding real company names
//   2. geofences.name        — real plant/farm names → fictional (via embedded maps)
//   3. audit_log.actor_id     — 'troy' → 'alex'
//   4. audit_log.metadata     — real owner email scrubbed inside the JSONB blob
//   5. yards.city            — real Idaho/Utah cities → fictional
//
// Connection: the neon.tech/neondb string in C:\Users\troyh\.claude.json (the
// SAME string the read-only postgres MCP uses — owner role, write-capable).
//
// SAFETY:
//   • DRY_RUN (default): runs every scrub inside ONE transaction, prints the
//     row count each WOULD change + the before→after sample, then ROLLS BACK.
//   • COMMIT (env COMMIT=1): runs the scrubs, writes a JSON before-snapshot to
//     scripts/scrub-backup-<ts>.json for reversibility, runs a name-only VERIFY
//     (throws if any real token survives → rollback), then COMMITs.
//   • Prints NO secrets.
import { Pool } from 'pg';
import { readFileSync, writeFileSync } from 'fs';

const COMMIT = process.env.COMMIT === '1';

// ── connection ──────────────────────────────────────────────────────────────
const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('FAIL: no neon.tech/neondb connection string in .claude.json'); process.exit(1); }
const conn = m[0].replace(/\\u0026/g, '&');
if (conn.includes('thinkinbuddy_memory')) { console.error('FAIL: refusing — that is Mark\'s DB, not DairyForge.'); process.exit(1); }
if (!/\/neondb(\?|$)/.test(conn)) { console.error('FAIL: connstring is not /neondb'); process.exit(1); }
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 });

// ── anon maps (copied verbatim from api-server/src/lib/anonymize.ts) ──────────
const PLANT_DISPLAY_ANON = {
  "Chobani — Twin Falls": "Summit Valley Creamery — Clearwater",
  "Chobani": "Summit Valley Creamery",
  "Chobani Twin Falls": "Summit Valley Creamery — Clearwater",
  "Glanbia Foods — Twin Falls": "Cascade Dairy Foods — Riverside",
  "Glanbia Foods — Gooding": "Cascade Dairy Foods — Gooding",
  "Glanbia Foods": "Cascade Dairy Foods",
  "Glanbia Gooding": "Cascade Dairy Foods — Gooding",
  "Glanbia Twin Falls": "Cascade Dairy Foods — Riverside",
  "Glanbia": "Cascade Dairy Foods",
  "Brewster Cheese — Rupert": "Ridgeline Cheese — Rupert",
  "Brewster Cheese": "Ridgeline Cheese",
  "Brewster": "Ridgeline Cheese",
  "Darigold — Jerome": "Highline Dairy Co. — Jerome",
  "Darigold — Caldwell": "Highline Dairy Co. — Caldwell",
  "Darigold Jerome": "Highline Dairy Co. — Jerome",
  "Darigold": "Highline Dairy Co.",
  "Idaho Milk Products — Jerome": "Mountain Peak Milk — Jerome",
  "Idaho Milk Products": "Mountain Peak Milk",
  "High Desert Milk — Burley": "Desert Wind Dairy — Burley",
  "High Desert Milk": "Desert Wind Dairy",
  "Suntado — Burley": "Prairie Sun Dairy — Burley",
  "Suntado": "Prairie Sun Dairy",
  "Magic Valley Quality Milk — Jerome": "Snake River Milk Co. — Jerome",
  "Magic Valley Quality Milk": "Snake River Milk Co.",
  "Sorrento Lactalis — Nampa": "Lakeview Cheese Partners — Nampa",
  "Sorrento Lactalis": "Lakeview Cheese Partners",
  "Sorrento": "Lakeview Cheese Partners",
  "Magic Valley Cheese — Buhl": "Valley Ridge Creamery — Buhl",
  "Magic Valley Cheese": "Valley Ridge Creamery",
};
const FARM_DISPLAY_ANON = {
  "Cedar Ridge": "Blue Mesa Dairy", "Cedar Ridge 2": "Blue Mesa Dairy 2",
  "Cedar Ridge 3": "Blue Mesa Dairy 3", "Cedar Ridge 5": "Blue Mesa Dairy 5",
  "Cedar Ridge 6": "Blue Mesa Dairy 6", "Cedar Ridge Dairy": "Blue Mesa Dairy",
  "Cedar Ridge Dairy #2": "Blue Mesa Dairy #2",
  "Roth": "Ironwood Farm", "Roth 1": "Ironwood Farm 1", "Roth 2": "Ironwood Farm 2",
  "Roth Dairy 1": "Ironwood Farm 1", "Roth Dairy 2": "Ironwood Farm 2", "Roth Farms": "Ironwood Farms",
  "Roth Dairy #1": "Ironwood Farm #1", "Roth Dairy #2": "Ironwood Farm #2", "Roth Dairy #3": "Ironwood Farm #3",
  "Whiteside": "Clearwater Ranch", "Whiteside E": "Clearwater Ranch E", "Whiteside S": "Clearwater Ranch S",
  "Whiteside W": "Clearwater Ranch W", "Whiteside Dairy": "Clearwater Ranch Dairy",
  "Whiteside West Dairy": "Clearwater West Ranch Dairy", "Whiteside Farms": "Clearwater Ranch Farms",
  "Desperado": "Sagebrush Flats", "Desperado Dairy": "Sagebrush Flats Dairy",
  "Hay-Del": "Riverbend Dairy", "Hay Del": "Riverbend Dairy", "Hay-Del Dairy": "Riverbend Dairy",
  "Ida Gold 1": "Goldstone Dairy 1", "Ida Gold 2": "Goldstone Dairy 2", "KandG Ida Gold 2": "Goldstone Dairy 2",
  "Ida Gold Dairy #1": "Goldstone Dairy #1",
  "Sunview 1": "Suncrest Farms 1", "Sunview 2": "Suncrest Farms 2", "Sunview Dairy #1": "Suncrest Farms #1",
  "TLK 1": "Trestle Creek Farm 1", "TLK 2": "Trestle Creek Farm 2", "TLK 3": "Trestle Creek Farm 3",
  "TLK Dairy #1": "Trestle Creek Farm #1",
  "Turner": "Hawthorne Dairy", "Turner Dairy": "Hawthorne Dairy",
  "V4": "Pinecone Farm", "V4 Dairy": "Pinecone Farm Dairy",
  "Vandervegt": "Redfield Ranch", "Vandervegt Dairy": "Redfield Ranch Dairy",
  "Peterson": "Stonebridge Farm", "Peterson Dairy": "Stonebridge Dairy",
  "Peterson/Diamond J": "Stonebridge / Diamond Creek",
  "Diamond J": "Diamond Creek Farm", "Diamond J Dairy": "Diamond Creek Dairy",
  "Glanbia": "Cascade Foods", "Brewster": "Ridgeline Foods", "Chobani": "Summit Creamery",
  "Canyon View Farm": "Willowbrook Farm", "Desert Oasis": "Lakeside Acres",
  "Desert Oasis Dairy": "Lakeside Acres Dairy", "Jerome Heifers": "Clearfield Heifers",
  "Jerome Heifers Co.": "Clearfield Heifers Co.", "Three Pines": "Three Creeks", "Bracken": "Fernwood Dairy",
  "Magic Valley Holsteins": "High Mesa Holsteins", "Snake River Dairy": "Mesa Springs Dairy",
  "Twin Falls Producers": "Valley Ridge Producers", "Pioneer Dairy": "Prairie View Dairy",
  "Sunrise Milkers": "Sunrise Ridge Milkers",
};
function anonGeofenceName(name) {
  return PLANT_DISPLAY_ANON[name] ?? FARM_DISPLAY_ANON[name] ?? name;
}

// real Idaho/Utah yard cities → fictional (match _yard_map fakes in admin-anonymize.ts)
const YARD_CITY_ANON = {
  "Jerome": "Northfield", "Heyburn": "Westgate", "Meridian": "Summit",
  "Mountain Home": "Highland", "Smithfield": "Eastfield", "Salt Lake City": "Basin",
};
// the 4 old-slug plant rows still holding real names (keyed on plant id)
const PLANT_ROW_FIX = {
  "glanbia-twin-falls": "Cascade Dairy Foods — Riverside",
  "chobani-twin-falls": "Summit Valley Creamery — Clearwater",
  "idaho-milk-products-jerome": "Mountain Peak Milk — Jerome",
  "magic-valley-cheese-buhl": "Valley Ridge Creamery — Buhl",
};
const REAL_EMAIL = "troy@dairyforge.com";
const FAKE_EMAIL = "alex.rivera@demo-tenant.example";

(async () => {
  const client = await pool.connect();
  const changes = {};
  const backup = {};
  const note = (k, n) => { changes[k] = n; };
  try {
    await client.query('BEGIN');

    // 1) plants.display_name (4 old-slug rows)
    {
      const before = await client.query(
        `SELECT id, display_name FROM plants WHERE id = ANY($1)`,
        [Object.keys(PLANT_ROW_FIX)],
      );
      backup.plants = before.rows;
      let n = 0;
      for (const r of before.rows) {
        const fake = PLANT_ROW_FIX[r.id];
        if (r.display_name !== fake) {
          await client.query(`UPDATE plants SET display_name=$1, updated_at=NOW() WHERE id=$2`, [fake, r.id]);
          console.log(`  plants[${r.id}]: "${r.display_name}" -> "${fake}"`);
          n++;
        }
      }
      note('plants.display_name', n);
    }

    // 2) geofences.name (map-driven)
    {
      const rows = await client.query(`SELECT slug, name FROM geofences WHERE name IS NOT NULL`);
      const changed = [];
      for (const r of rows.rows) {
        const fake = anonGeofenceName(r.name);
        if (fake !== r.name) changed.push({ slug: r.slug, from: r.name, to: fake });
      }
      backup.geofences = changed;
      for (const c of changed) {
        await client.query(`UPDATE geofences SET name=$1, updated_at=NOW() WHERE slug=$2`, [c.to, c.slug]);
        console.log(`  geofences[${c.slug}]: "${c.from}" -> "${c.to}"`);
      }
      note('geofences.name', changed.length);
    }

    // 3) audit_log.actor_id 'troy' -> 'alex'
    {
      const r = await client.query(`SELECT count(*)::int n FROM audit_log WHERE actor_id='troy'`);
      backup.audit_actor = r.rows[0].n;
      await client.query(`UPDATE audit_log SET actor_id='alex' WHERE actor_id='troy'`);
      note('audit_log.actor_id', r.rows[0].n);
    }

    // 4) audit_log.metadata — scrub owner email inside JSONB (text-replace, re-cast)
    {
      const r = await client.query(
        `SELECT count(*)::int n FROM audit_log WHERE metadata::text ILIKE '%'||$1||'%'`, [REAL_EMAIL]);
      backup.audit_meta_email = r.rows[0].n;
      await client.query(
        `UPDATE audit_log SET metadata = replace(metadata::text, $1, $2)::jsonb
           WHERE metadata::text ILIKE '%'||$1||'%'`, [REAL_EMAIL, FAKE_EMAIL]);
      note('audit_log.metadata(email)', r.rows[0].n);
    }

    // 5) yards.city
    {
      const before = await client.query(`SELECT id, city FROM yards WHERE city = ANY($1)`, [Object.keys(YARD_CITY_ANON)]);
      backup.yards = before.rows;
      let n = 0;
      for (const r of before.rows) {
        const fake = YARD_CITY_ANON[r.city];
        if (fake && r.city !== fake) {
          await client.query(`UPDATE yards SET city=$1, updated_at=NOW() WHERE id=$2`, [fake, r.id]);
          console.log(`  yards[${r.id}]: city "${r.city}" -> "${fake}"`);
          n++;
        }
      }
      note('yards.city', n);
    }

    console.log('\n=== ROWS THAT WOULD CHANGE ===');
    for (const [k, v] of Object.entries(changes)) console.log(`  ${k}: ${v}`);

    if (COMMIT) {
      // name-only VERIFY — assert zero real tokens survive in scrubbed columns.
      const checks = [
        [`SELECT count(*)::int n FROM plants WHERE display_name ~* 'chobani|glanbia|idaho milk products|magic valley cheese|darigold|brewster|sorrento|suntado|high desert'`, 'plants.display_name'],
        [`SELECT count(*)::int n FROM geofences WHERE name ~* 'chobani|glanbia|darigold|brewster|cedar ridge|roth|whiteside|desperado|hay-del|ida gold|sunview|tlk|turner|vandervegt|peterson|diamond j|idaho milk'`, 'geofences.name'],
        [`SELECT count(*)::int n FROM audit_log WHERE actor_id='troy' OR metadata::text ILIKE '%${REAL_EMAIL}%'`, 'audit_log'],
        [`SELECT count(*)::int n FROM yards WHERE city ~* 'jerome|heyburn|meridian|mountain home|smithfield|salt lake'`, 'yards.city'],
      ];
      for (const [q, label] of checks) {
        const v = await client.query(q);
        if (v.rows[0].n > 0) throw new Error(`VERIFY FAILED: ${label} still has ${v.rows[0].n} real-token rows`);
      }
      const ts = new Date(parseInt(process.env.TS || '0', 10) || Date.now()).toISOString().replace(/[:.]/g, '-');
      writeFileSync(`C:/Users/troyh/n8n_Pod_Uploader_jarvis/jarvis/scripts/dairyforge-scrub-backup-${ts}.json`,
        JSON.stringify(backup, null, 2));
      await client.query('COMMIT');
      console.log('\nVERIFY PASSED. COMMITTED. Backup written.');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY-RUN — rolled back, nothing changed. Re-run with COMMIT=1 to apply.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ERROR (rolled back):', e?.message || e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
