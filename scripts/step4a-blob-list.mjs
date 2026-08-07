// scripts/step4a-blob-list.mjs — READ-ONLY. Lists Vercel Blobs under the troy memory prefix and
// downloads + inspects the shape of the newest JSON. Prints NO secrets.
// Run: node scripts/step4a-blob-list.mjs
import { readFileSync } from 'fs';

function envVal(key) {
  const e = readFileSync('C:/Users/troyh/n8n_Pod_Uploader_thinkinbuddy/thinkinbuddy/.env.production.local', 'utf8');
  for (const line of e.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

const TOKEN = envVal('BLOB_READ_WRITE_TOKEN');
if (!TOKEN) { console.error('FAIL: no BLOB_READ_WRITE_TOKEN'); process.exit(1); }
const PREFIX = 'thinkinbuddy/memory/troy/';

(async () => {
  const res = await fetch(`https://blob.vercel-storage.com?prefix=${encodeURIComponent(PREFIX)}&limit=1000`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) { console.error('list failed', res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  const blobs = data.blobs || [];
  console.log('blob count under prefix:', blobs.length);
  for (const b of blobs) {
    console.log(`  - ${b.pathname}  size=${b.size}  uploadedAt=${b.uploadedAt}`);
  }
  if (!blobs.length) { console.log('no blobs found'); return; }

  // Newest by uploadedAt
  const newest = [...blobs].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
  console.log('\nNEWEST:', newest.pathname, '->', newest.url);
  const j = await fetch(newest.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await j.text();
  console.log('\n--- raw (first 1500 chars) ---');
  console.log(text.slice(0, 1500));
  console.log('\n--- shape ---');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      console.log('top-level: ARRAY, length', parsed.length, 'first item keys:', Object.keys(parsed[0] || {}));
    } else {
      console.log('top-level: OBJECT, keys:', Object.keys(parsed));
      if (Array.isArray(parsed.facts)) console.log('facts length:', parsed.facts.length, 'first fact keys:', Object.keys(parsed.facts[0] || {}));
    }
  } catch (e) { console.log('NOT valid JSON:', e.message); }
})();
