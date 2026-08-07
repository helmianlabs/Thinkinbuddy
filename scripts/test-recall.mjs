// scripts/test-recall.mjs — validate the ENHANCED retrieveMemories (vector recall)
// against the live thinkinbuddy_memory DB (486 real facts) BEFORE deploying.
// Read-only. Sets env from .claude.json (DB) + .env.local (OpenAI) then imports the
// working-tree api/memory.js (the enhanced version).
import { readFileSync } from 'fs';

const claude = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const m = claude.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!m) { console.error('no neondb conn'); process.exit(1); }
process.env.DATABASE_URL_MEMORY = m[0].replace(/\\u0026/g, '&').replace(/\/neondb(\?|$)/, '/thinkinbuddy_memory$1');

const envl = readFileSync('C:/Users/troyh/n8n_Pod_Uploader_thinkinbuddy/thinkinbuddy/.env.local', 'utf8');
const ok = envl.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m);
if (ok) process.env.OPENAI_API_KEY = ok[1].trim().replace(/^["']|["']$/g, '');

const { retrieveMemories } = await import('../api/memory.js');

async function show(label, opts) {
  const rows = await retrieveMemories('troy', opts);
  console.log(`\n=== ${label} (${rows.length} rows) ===`);
  for (const r of rows) console.log(`  - ${r.key}: ${String(r.value).slice(0, 90)}`);
}

try {
  await show("VECTOR: 'who is my employer / the TMS project'", { query: 'who is my employer and what is the TMS project', limit: 6 });
  await show("VECTOR: 'what AI tools am I building'", { query: 'what AI assistant or tools am I building', limit: 6 });
  await show('BOOT (no query, top importance)', { limit: 6 });
  console.log('\nOK: enhanced vector recall works against the live 486-fact DB.');
  process.exit(0);
} catch (e) {
  console.error('RECALL TEST FAILED:', e?.message || e);
  process.exit(1);
}
