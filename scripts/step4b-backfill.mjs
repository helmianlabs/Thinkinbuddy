// scripts/step4b-backfill.mjs — WRITE. Backfills the 15 older facts from the NEWEST Vercel Blob
// snapshot into memory_items under user_id='troy'. Embeds `${key}: ${value}` via OpenAI
// text-embedding-3-small. DEDUP: skips any subject already present under 'troy'. If embedding
// fails for a fact, inserts with embedding NULL and notes it. Does NOT delete the Blob source.
// Run: node scripts/step4b-backfill.mjs
import { Pool } from 'pg';
import { readFileSync } from 'fs';

function envVal(key, file = 'C:/Users/troyh/n8n_Pod_Uploader_jarvis/jarvis/.env.production.local') {
  const e = readFileSync(file, 'utf8');
  for (const line of e.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

const TOKEN = envVal('BLOB_READ_WRITE_TOKEN');
// OPENAI_API_KEY is EMPTY in .env.production.local — the real key lives in .env.local.
// Try production.local first, then fall back to .env.local. (Verified 2026-06-09.)
const OPENAI_KEY = envVal('OPENAI_API_KEY')
  || envVal('OPENAI_API_KEY', 'C:/Users/troyh/n8n_Pod_Uploader_jarvis/jarvis/.env.local');
if (!TOKEN) { console.error('FAIL: no BLOB_READ_WRITE_TOKEN'); process.exit(1); }
if (!OPENAI_KEY) { console.error('FAIL: no OPENAI_API_KEY in production.local or .env.local'); process.exit(1); }

const raw = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('FAIL: no neondb connection string found in .claude.json'); process.exit(1); }
const memConn = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/thinkinbuddy_memory$1');
const pool = new Pool({ connectionString: memConn, ssl: { rejectUnauthorized: false }, max: 2 });

const PREFIX = 'thinkinbuddy/memory/troy/';

async function embed(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.data[0].embedding; // 1536 floats
}

(async () => {
  try {
    // 1) Fetch newest blob snapshot.
    const listRes = await fetch(`https://blob.vercel-storage.com?prefix=${encodeURIComponent(PREFIX)}&limit=1000`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const { blobs = [] } = await listRes.json();
    if (!blobs.length) { console.log('no blobs — nothing to backfill'); return; }
    const newest = [...blobs].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    const snap = await (await fetch(newest.url, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    const facts = Array.isArray(snap.facts) ? snap.facts : [];
    console.log(`source blob: ${newest.pathname} — ${facts.length} facts`);

    // 2) Existing 'troy' subjects for dedup.
    const exist = await pool.query(`SELECT lower(subject) AS s FROM memory_items WHERE user_id='troy'`);
    const have = new Set(exist.rows.map(r => r.s));
    console.log(`existing 'troy' subjects: ${have.size}`);

    let inserted = 0, skipped = 0, nullEmb = 0;
    const skippedList = [], insertedList = [], nullEmbList = [];

    for (const f of facts) {
      const key = String(f.key || '').trim();
      const value = String(f.value ?? '').trim();
      if (!key) { skipped++; skippedList.push('(empty key)'); continue; }
      const subject = key.slice(0, 120);
      if (have.has(subject.toLowerCase())) { skipped++; skippedList.push(subject); continue; }

      let vec = null;
      try { vec = await embed(`${key}: ${value}`); }
      catch (e) { console.warn(`  embed failed for "${key}": ${e.message} — inserting NULL embedding`); }

      const content = value.slice(0, 500);
      if (vec) {
        const lit = '[' + vec.join(',') + ']';
        await pool.query(
          `INSERT INTO memory_items (user_id, scope, kind, subject, content, embedding, confidence, importance)
             VALUES ('troy','semantic','fact',$1,$2,$3::vector,0.7,0.6)`,
          [subject, content, lit]);
        insertedList.push(subject);
      } else {
        await pool.query(
          `INSERT INTO memory_items (user_id, scope, kind, subject, content, embedding, confidence, importance)
             VALUES ('troy','semantic','fact',$1,$2,NULL,0.7,0.6)`,
          [subject, content]);
        nullEmb++; nullEmbList.push(subject);
      }
      inserted++;
      have.add(subject.toLowerCase());
    }

    console.log(`\n=== BACKFILL RESULT ===`);
    console.log(`inserted: ${inserted} (with NULL embedding: ${nullEmb})`);
    console.log(`skipped (dedup): ${skipped}`);
    console.log(`inserted subjects: ${JSON.stringify(insertedList)}`);
    console.log(`skipped subjects:  ${JSON.stringify(skippedList)}`);
    if (nullEmbList.length) console.log(`NULL-embedding subjects: ${JSON.stringify(nullEmbList)}`);
  } catch (e) {
    console.error('ERROR:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
