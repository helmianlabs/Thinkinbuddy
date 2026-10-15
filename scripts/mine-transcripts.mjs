// scripts/mine-transcripts.mjs
// ---------------------------------------------------------------------------
// Mine ALL ElevenLabs (ThinkinBuddy) conversation transcripts for agent
// agent_5301m50skfnvfza8bpkmjybc18z8 into Troy's live persistent-memory DB
// (Neon `thinkinbuddy_memory`, table memory_items, user_id='troy').
//
// Pipeline (per the task spec + thinkinbuddy/api/extract-memories.js patterns):
//   1. List ALL conversations (paginate cursor/has_more until exhausted).
//   2. Fetch each transcript (role + message turns).
//   3. Extract durable memory candidates via claude-haiku-4-5 + EXTRACT_PROMPT
//      (verbatim from the spec). Tolerate bad JSON; skip convo on parse fail.
//   4. Per candidate: looksLikePII filter (subject+content) + content<=500 cap;
//      embed `${subject}: ${content}` via OpenAI text-embedding-3-small (1536-d).
//   5. DEDUP: cosine-nearest existing 'troy' row; if similarity >= 0.92 SKIP.
//      Else INSERT into memory_items (user_id='troy', scope='semantic',
//      kind=candidate.kind||'fact', subject, content, embedding=$vec::vector,
//      confidence, importance, source_session=conversation_id).
//   6. Resilient: try/catch per conversation; rate-limit Anthropic calls;
//      progress log every ~10 conversations.
//
// SAFETY: purely ADDITIVE. Every INSERT sets source_session=<conversation_id>
// so the whole run is traceable + revertible:
//   DELETE FROM memory_items WHERE user_id='troy' AND source_session IN (<ids>);
// This script NEVER deletes or updates existing rows, and only ever touches
// user_id='troy'. Existing troy rows have source_session=NULL (verified), so
// they are cleanly distinguishable from this run's inserts.
//
// Flags:
//   --dry-run    Do everything EXCEPT the final INSERT (no writes). Prints what
//                WOULD be inserted vs skipped. Use to preview safely.
//   --limit=N    Process only the first N conversations (for a small test run).
//
// Run from the thinkinbuddy repo dir (pg lives in its node_modules):
//   node scripts/mine-transcripts.mjs --dry-run --limit=3
//   node scripts/mine-transcripts.mjs
// ---------------------------------------------------------------------------
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const AGENT_ID = 'agent_5301m50skfnvfza8bpkmjybc18z8';
const USER_ID = 'troy';
const SIM_DUP = 0.92;            // >= this cosine similarity → skip as near-duplicate
const MAX_CONTENT_LEN = 500;
const ANTHROPIC_DELAY_MS = 600;  // polite delay between Anthropic extraction calls
const EMBED_MODEL = 'text-embedding-3-small';
const HAIKU_MODEL = 'claude-haiku-4-5';

// ---- flags ----
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const a = args.find(x => x.startsWith('--limit='));
  return a ? Math.max(0, parseInt(a.split('=')[1], 10) || 0) : 0;
})();

// ---- keys from .env.local (REAL values per task) ----
const ENV_PATH = 'C:/Users/troyh/n8n_Pod_Uploader_thinkinbuddy/thinkinbuddy/.env.local';
const env = readFileSync(ENV_PATH, 'utf8');
const getKey = (name) => {
  const m = env.match(new RegExp('^' + name + '=(.+)$', 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};
const ELEVEN_KEY = getKey('ELEVENLABS_API_KEY');
const ANTHROPIC_KEY = getKey('ANTHROPIC_API_KEY');
const OPENAI_KEY = getKey('OPENAI_API_KEY');
if (!ELEVEN_KEY)    { console.error('FATAL: ELEVENLABS_API_KEY missing'); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error('FATAL: ANTHROPIC_API_KEY missing'); process.exit(1); }
if (!OPENAI_KEY)    { console.error('FATAL: OPENAI_API_KEY missing'); process.exit(1); }

// ---- DB connection: derive from neondb string in .claude.json, swap db name ----
const rawClaude = readFileSync('C:/Users/troyh/.claude.json', 'utf8');
const cm = rawClaude.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
if (!cm) { console.error('FATAL: no neondb connection string found in .claude.json'); process.exit(1); }
const neon = cm[0].replace(/\\u0026/g, '&');
const MEM_CONN = neon.replace(/\/neondb(\?|$)/, '/thinkinbuddy_memory$1');
const pool = new Pool({ connectionString: MEM_CONN, ssl: { rejectUnauthorized: false }, max: 3 });

// ---------------------------------------------------------------------------
// PII filter + EXTRACT_PROMPT — verbatim from thinkinbuddy/api/extract-memories.js
// (which itself is verbatim from the spec lines 262-300).
// ---------------------------------------------------------------------------
const PII_PATTERNS = [
  /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/,
  /\bpk_(live|test)_[A-Za-z0-9]{16,}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{36,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b[A-Za-z0-9_-]{32,}\b(?=.{0,40}(api[_ -]?key|secret|token))/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
function looksLikePII(text) { return PII_PATTERNS.some(rx => rx.test(text)); }
function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }

const EXTRACT_PROMPT = `
You are a memory extractor for a personal voice assistant. From the transcript below, produce a JSON array of memory candidates that are worth remembering across future sessions.

Rules:
- Only extract DURABLE facts, preferences, identities, decisions, project state, explicit feedback, or time-bound reminders.
- Ignore small talk, current-turn task state, and anything that will be obsolete in <24 hours unless flagged as a reminder with valid_until.
- For each candidate include: kind, subject (3-6 words), content (one declarative sentence, <500 chars), confidence (0-1), importance (0-1), source_span {start, end} (message indices).
- NEVER include credentials, API keys, passwords, tokens, SSNs, credit card numbers, or other PII in the content field. If a fact requires referencing such a value, describe the existence of it ("user stored a Stripe key in env") without the value.
- Output ONLY valid JSON. No prose, no markdown fences.

Schema:
[{
  "kind": "fact|preference|identity|decision|project_state|task|feedback|reminder",
  "subject": "string",
  "content": "string",
  "confidence": 0.0-1.0,
  "importance": 0.0-1.0,
  "valid_until": "ISO8601 or null",
  "source_span": { "start": int, "end": int }
}]
`.trim();

// ---------------------------------------------------------------------------
// Robust JSON parse for LLM output (strip fences; pull first [...] block).
// Verbatim logic from extract-memories.js parseCandidates.
// ---------------------------------------------------------------------------
function parseCandidates(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  let parsed = tryParse(raw.trim());
  if (Array.isArray(parsed)) return parsed;
  const defenced = raw.replace(/^\s*```(?:json)?/im, '').replace(/```\s*$/im, '').trim();
  parsed = tryParse(defenced);
  if (Array.isArray(parsed)) return parsed;
  const m = defenced.match(/\[[\s\S]*\]/);
  if (m) { parsed = tryParse(m[0]); if (Array.isArray(parsed)) return parsed; }
  return [];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ElevenLabs: list ALL conversation ids (paginate until has_more=false).
// ---------------------------------------------------------------------------
async function listAllConversationIds() {
  let cursor = null;
  const ids = [];
  do {
    const url = new URL('https://api.elevenlabs.io/v1/convai/conversations');
    url.searchParams.set('agent_id', AGENT_ID);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const r = await fetch(url, { headers: { 'xi-api-key': ELEVEN_KEY } });
    if (!r.ok) throw new Error(`list ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    for (const c of (d.conversations || [])) ids.push(c.conversation_id);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return ids;
}

// Fetch transcript turns ([{role, message}, ...]) for one conversation.
async function fetchTranscript(conversationId) {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
    { headers: { 'xi-api-key': ELEVEN_KEY } }
  );
  if (!r.ok) throw new Error(`transcript ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return data?.transcript || [];
}

// ---------------------------------------------------------------------------
// Claude Haiku extraction → filtered candidate objects.
// Mirrors extract-memories.js extractCandidates (numbering, roles, filtering).
// ---------------------------------------------------------------------------
async function extractCandidates(transcript, conversationId) {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];
  const numbered = transcript
    .map((t, i) => {
      const role = t.role === 'user' ? 'USER' : 'BUDDY';
      const text = (t.message || '').trim();
      return text ? `[${i}] ${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');
  if (!numbered) return [];

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1500,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: numbered }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = data?.content?.[0]?.text || '';

  const parsed = parseCandidates(text);
  if (!Array.isArray(parsed)) return [];

  const out = [];
  let piiSkipped = 0;
  for (const c of parsed) {
    if (!c || typeof c.content !== 'string') continue;
    const content = c.content.trim();
    const subject = typeof c.subject === 'string' ? c.subject.trim() : '';
    if (!content) continue;
    if (content.length > MAX_CONTENT_LEN) { piiSkipped += 0; continue; } // length cap: drop
    if (looksLikePII(content) || looksLikePII(subject)) { piiSkipped++; continue; }
    out.push({
      kind: (typeof c.kind === 'string' && c.kind) ? c.kind : 'fact',
      subject: subject.slice(0, 120),
      content,
      confidence: clamp01(c.confidence ?? 0.7),
      importance: clamp01(c.importance ?? 0.5),
      valid_until: (typeof c.valid_until === 'string' && !Number.isNaN(Date.parse(c.valid_until))) ? c.valid_until : null,
      source_session: conversationId,
    });
  }
  return { candidates: out, rawCount: parsed.length, piiSkipped };
}

// OpenAI embedding for one string → number[1536].
async function embed(textInput) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: textInput }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const v = d?.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length !== 1536) throw new Error(`bad embedding dim ${v?.length}`);
  return v;
}

// pgvector literal: [a,b,c] (no spaces needed but harmless)
const toVec = (arr) => '[' + arr.join(',') + ']';

// Nearest existing 'troy' neighbor cosine similarity (1 - cosine_distance).
// Uses pgvector <=> (cosine distance). Returns top similarity in [−1,1].
async function nearestSimilarity(client, vecLiteral) {
  const q = await client.query(
    `SELECT 1 - (embedding <=> $1::vector) AS sim
       FROM memory_items
      WHERE user_id = $2 AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT 1`,
    [vecLiteral, USER_ID]
  );
  return q.rows.length ? Number(q.rows[0].sim) : -1;
}

async function insertRow(client, c, vecLiteral) {
  await client.query(
    `INSERT INTO memory_items
       (user_id, scope, kind, subject, content, embedding, confidence, importance, source_session)
     VALUES ($1, 'semantic', $2, $3, $4, $5::vector, $6, $7, $8)`,
    [USER_ID, c.kind, c.subject, c.content, vecLiteral, c.confidence, c.importance, c.source_session]
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const host = (MEM_CONN.match(/@([^/]+)\//) || [])[1] || '(?)';
  console.log(`mine-transcripts → thinkinbuddy_memory on ${host}`);
  console.log(`mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'LIVE (will INSERT)'}${LIMIT ? ` | limit=${LIMIT}` : ''}`);

  // Run-start timestamp from the DB clock — used to scope a PRECISE, SAFE revert
  // (this run only). NOTE: the live extract-memories app has already written
  // ~51 conv-sourced rows over the past week, so a blanket `LIKE 'conv_%'`
  // revert would wrongly delete those. We scope revert by created_at >= run start.
  const tsQ = await pool.query('SELECT now() AS now');
  const RUN_START = tsQ.rows[0].now.toISOString();

  // Baseline count (source-of-truth before/after).
  const baseQ = await pool.query(`SELECT count(*)::int n FROM memory_items WHERE user_id=$1`, [USER_ID]);
  const baseline = baseQ.rows[0].n;
  console.log(`run start (DB clock): ${RUN_START}`);
  console.log(`baseline troy rows: ${baseline}\n`);

  let ids = await listAllConversationIds();
  console.log(`conversations found: ${ids.length}`);
  if (LIMIT) ids = ids.slice(0, LIMIT);
  console.log(`conversations to process: ${ids.length}\n`);

  const stats = {
    found: ids.length,
    processed: 0,
    emptyTranscript: 0,
    candidatesExtracted: 0,
    piiSkipped: 0,
    inserted: 0,
    skippedDuplicate: 0,
    errored: [],
  };

  for (let i = 0; i < ids.length; i++) {
    const cid = ids[i];
    try {
      const transcript = await fetchTranscript(cid);
      if (!Array.isArray(transcript) || transcript.length === 0) {
        stats.emptyTranscript++;
        stats.processed++;
        continue;
      }

      // Rate-limit the Anthropic extraction call.
      const ex = await extractCandidates(transcript, cid);
      await sleep(ANTHROPIC_DELAY_MS);

      const candidates = ex.candidates || [];
      stats.candidatesExtracted += candidates.length;
      stats.piiSkipped += ex.piiSkipped || 0;

      for (const c of candidates) {
        try {
          const vec = await embed(`${c.subject}: ${c.content}`);
          const vecLiteral = toVec(vec);

          // Dedup against existing troy rows (and against rows inserted earlier
          // this run, since those are now in the table for LIVE mode).
          const client = await pool.connect();
          try {
            const sim = await nearestSimilarity(client, vecLiteral);
            if (sim >= SIM_DUP) {
              stats.skippedDuplicate++;
              continue;
            }
            if (DRY_RUN) {
              stats.inserted++; // count as "would insert"
            } else {
              await insertRow(client, c, vecLiteral);
              stats.inserted++;
            }
          } finally {
            client.release();
          }
        } catch (candErr) {
          // A single candidate failing (embed/insert) must not kill the convo.
          stats.errored.push({ cid, where: 'candidate', msg: String(candErr?.message || candErr).slice(0, 160) });
        }
      }

      stats.processed++;
    } catch (convErr) {
      stats.errored.push({ cid, where: 'conversation', msg: String(convErr?.message || convErr).slice(0, 160) });
      stats.processed++; // counted as attempted
    }

    if ((i + 1) % 10 === 0 || i === ids.length - 1) {
      console.log(`  [${i + 1}/${ids.length}] processed=${stats.processed} candidates=${stats.candidatesExtracted} inserted${DRY_RUN ? '(would)' : ''}=${stats.inserted} dupSkip=${stats.skippedDuplicate} piiSkip=${stats.piiSkipped} errors=${stats.errored.length}`);
    }
  }

  // Final total (LIVE: re-query; DRY: baseline + would-insert for reference).
  let finalTotal = baseline;
  if (!DRY_RUN) {
    const fq = await pool.query(`SELECT count(*)::int n FROM memory_items WHERE user_id=$1`, [USER_ID]);
    finalTotal = fq.rows[0].n;
  }

  console.log('\n==================== SUMMARY ====================');
  console.log(`mode:                         ${DRY_RUN ? 'DRY-RUN (no writes)' : 'LIVE'}`);
  console.log(`conversations found:          ${stats.found}`);
  console.log(`conversations processed:      ${stats.processed}`);
  console.log(`  empty transcripts:          ${stats.emptyTranscript}`);
  console.log(`candidates extracted:         ${stats.candidatesExtracted}`);
  console.log(`  inserted${DRY_RUN ? ' (would)' : '        '}:           ${stats.inserted}`);
  console.log(`  skipped as duplicate:       ${stats.skippedDuplicate}`);
  console.log(`  skipped PII (in-extract):   ${stats.piiSkipped}`);
  console.log(`conversations errored:        ${stats.errored.length}`);
  for (const e of stats.errored.slice(0, 20)) console.log(`    - ${e.cid} [${e.where}]: ${e.msg}`);
  if (stats.errored.length > 20) console.log(`    ... +${stats.errored.length - 20} more`);
  console.log(`baseline troy rows:           ${baseline}`);
  console.log(`FINAL troy row count:         ${finalTotal}${DRY_RUN ? '  (unchanged — dry run)' : ''}`);
  console.log('================================================');
  if (!DRY_RUN) {
    console.log('\nRevert THIS run ONLY (scoped by run-start timestamp — safe, leaves prior app rows intact):');
    console.log(`  DELETE FROM memory_items WHERE user_id='troy' AND source_session LIKE 'conv_%' AND created_at >= '${RUN_START}';`);
  }

  await pool.end();
})().catch(async (e) => {
  console.error('FATAL:', e?.message || e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
