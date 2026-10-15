// api/extract-memories.js — called by index.html when an ElevenLabs call ends.
//
// 1. Pulls the conversation transcript from the ElevenLabs ConvAI API.
// 2. Asks Claude to extract durable memory CANDIDATES about the user (full spec
//    schema: kind, subject, content, confidence, importance, valid_until,
//    source_span) — not just {key,value} pairs.
// 3. Applies a PII filter + length cap (spec lines 262-278), then persists via
//    saveMemoryCandidates (semantic dedup + supersedes, spec lines 355-468),
//    imported from api/memory.js. If that export is unavailable (Slice A landing
//    in parallel), falls back to the existing upsertExtractedFact path.
//    source_session = ElevenLabs conversationId.
//
// 2026-06-02: PHASE 2 of the Neon migration. Was Vercel Blob → now Neon.
// 2026-06-08: SLICE B — richer extraction + PII filter + candidate persistence.
//
// Frontend fires this fire-and-forget on `elevenlabs-convai:call-ended`.
// Response status is for debugging — the client ignores it.

import { getPool, upsertExtractedFact } from './memory.js';

// ---------------------------------------------------------------------------
// PII filter + length cap — verbatim from spec lines 262-278.
// Applied BEFORE persisting: skip any candidate whose content OR subject
// looks like a credential / PII, and drop anything over MAX_CONTENT_LEN.
// ---------------------------------------------------------------------------
const PII_PATTERNS = [
  /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/,           // Stripe secret
  /\bpk_(live|test)_[A-Za-z0-9]{16,}\b/,           // Stripe publishable (still flag)
  /\bgh[opusr]_[A-Za-z0-9]{36,}\b/,                // GitHub PAT family
  /\bAKIA[0-9A-Z]{16}\b/,                          // AWS access key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,              // Slack tokens
  /\b\d{3}-\d{2}-\d{4}\b/,                         // SSN-shape
  /\b(?:\d[ -]*?){13,19}\b/,                       // CC-shape (loose)
  /\b[A-Za-z0-9_-]{32,}\b(?=.{0,40}(api[_ -]?key|secret|token))/i, // generic key+hint
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const MAX_CONTENT_LEN = 500;

function looksLikePII(text) {
  return PII_PATTERNS.some(rx => rx.test(text));
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

// ---------------------------------------------------------------------------
// Extractor prompt — full candidate schema, verbatim from spec lines 280-300.
// ---------------------------------------------------------------------------
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

async function fetchTranscript(conversationId, elevenKey) {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
    { headers: { 'xi-api-key': elevenKey } }
  );
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`ElevenLabs ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  return data?.transcript || [];
}

// Extract full memory candidates from the transcript via Claude.
// Returns an array of candidate objects matching the spec MemoryCandidate shape
// (spec lines 328-341): scope, kind, subject, content, confidence, importance,
// valid_until, source_session, source_span{start,end}. PII/length filtering is
// applied here so nothing dirty reaches the persistence layer.
async function extractCandidates(transcript, conversationId, anthropicKey) {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];

  // Number each line so the LLM can cite source_span message indices, and so the
  // role labels match what the model expects (role + content).
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
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: numbered }],
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Anthropic ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = data?.content?.[0]?.text || '';

  const parsed = parseCandidates(text);
  if (!Array.isArray(parsed)) return [];

  const out = [];
  for (const c of parsed) {
    if (!c || typeof c.content !== 'string') continue;
    const content = c.content.trim();
    const subject = typeof c.subject === 'string' ? c.subject.trim() : '';
    if (!content) continue;

    // Length cap (spec :274 / :325) — drop, don't truncate, so we never
    // persist a sentence cut mid-PII.
    if (content.length > MAX_CONTENT_LEN) continue;

    // PII filter (spec :276-278 / :326) — applied to BOTH content and subject
    // BEFORE persisting.
    if (looksLikePII(content) || looksLikePII(subject)) continue;

    out.push({
      scope: 'semantic',                       // spec :329 — dedup/save can promote scope
      kind: typeof c.kind === 'string' && c.kind ? c.kind : 'fact',
      subject: subject.slice(0, 120),          // spec :331
      content,                                 // already <= MAX_CONTENT_LEN
      confidence: clamp01(c.confidence ?? 0.7),// spec :333
      importance: clamp01(c.importance ?? 0.5),// spec :334
      valid_until: (typeof c.valid_until === 'string' && !Number.isNaN(Date.parse(c.valid_until))) ? c.valid_until : null,      // spec :335
      source_session: conversationId,          // spec :336
      source_span: {                           // spec :337-340
        start: Number(c.source_span?.start ?? 0) || 0,
        end:   Number(c.source_span?.end ?? 0) || 0,
      },
    });
  }
  return out;
}

// Robust JSON parse for the LLM output (spec :313-320 pattern, generalized).
// Handles: clean JSON array, accidental ```json fences, and prose-wrapped JSON
// by extracting the first [...] block. Returns an array or [].
function parseCandidates(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

  // 1) Direct parse.
  let parsed = tryParse(raw.trim());
  if (Array.isArray(parsed)) return parsed;

  // 2) Strip accidental markdown code fences and retry (spec :318).
  const defenced = raw
    .replace(/^\s*```(?:json)?/im, '')
    .replace(/```\s*$/im, '')
    .trim();
  parsed = tryParse(defenced);
  if (Array.isArray(parsed)) return parsed;

  // 3) Last resort: pull the first JSON array out of surrounding prose.
  const m = defenced.match(/\[[\s\S]*\]/);
  if (m) {
    parsed = tryParse(m[0]);
    if (Array.isArray(parsed)) return parsed;
  }
  return [];
}

// Persist candidates. Prefer saveMemoryCandidates (semantic dedup + supersedes,
// spec :360-455). Slice A adds that export to memory.js in parallel; if it isn't
// available yet, fall back to upsertExtractedFact (one row per candidate, no
// embedding-based dedup). Returns a normalized summary either way.
async function persistCandidates(userId, candidates, conversationId, anthropicKey) {
  let saveMemoryCandidates = null;
  try {
    const mod = await import('./memory.js');
    if (typeof mod.saveMemoryCandidates === 'function') {
      saveMemoryCandidates = mod.saveMemoryCandidates;
    }
  } catch (e) {
    console.error('[extract-memories] memory.js import failed:', e?.message || e);
  }

  if (saveMemoryCandidates) {
    const pool = getPool();
    // LLM adapter for contradiction classification inside saveMemoryCandidates
    // (spec :457-468). Same Anthropic surface used above.
    const llm = (system, user) => anthropicComplete(system, user, anthropicKey);
    const res = await saveMemoryCandidates(pool, userId, candidates, llm);
    return {
      path: 'saveMemoryCandidates',
      inserted: res?.inserted ?? 0,
      updated: res?.updated ?? 0,
      superseded: res?.superseded ?? 0,
      persisted: (res?.inserted ?? 0) + (res?.updated ?? 0) + (res?.superseded ?? 0),
    };
  }

  // Fallback: write each candidate as a {key=subject, value=content} fact.
  let persisted = 0;
  const keys = [];
  for (const c of candidates) {
    try {
      const out = await upsertExtractedFact({
        userId,
        key: c.subject || c.content.slice(0, 60),
        value: c.content,
        importance: c.importance,
        sourceSession: conversationId,
      });
      persisted++;
      keys.push(out.subject);
    } catch (err) {
      console.error('[extract-memories] fallback upsert failed for subject', c.subject, err?.message || err);
    }
  }
  return { path: 'upsertExtractedFact(fallback)', persisted, keys };
}

// Minimal Anthropic text completion used as the contradiction-classifier LLM
// adapter for saveMemoryCandidates. Returns the model's text (or '' on shape
// surprises); callers tolerate empty (classifier defaults to 'unrelated').
async function anthropicComplete(system, user, anthropicKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 16,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Anthropic ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  return data?.content?.[0]?.text || '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, conversationId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!elevenKey)    return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    // ElevenLabs sometimes needs a beat to finalize the transcript.
    // One short retry handles the race; longer retries belong in a job queue.
    let transcript = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      transcript = await fetchTranscript(conversationId, elevenKey);
      if (transcript.length > 0) break;
      await new Promise(r => setTimeout(r, 1500));
    }

    if (transcript.length === 0) {
      // 425 Too Early — transcript not yet finalized. Client should treat as "not done yet" and re-fire on the
      // next terminal event (disconnect/pagehide). Returning 200 caused extractFired to latch and the real
      // end-of-call write to be skipped.
      return res.status(425).json({ ok: false, extracted: 0, reason: 'empty transcript' });
    }

    const candidates = await extractCandidates(transcript, conversationId, anthropicKey);
    if (candidates.length === 0) {
      return res.status(200).json({ ok: true, extracted: 0, reason: 'no durable facts' });
    }

    const result = await persistCandidates(userId, candidates, conversationId, anthropicKey);

    return res.status(200).json({
      ok: true,
      candidates: candidates.length,
      extracted: result.persisted,
      path: result.path,
      ...(result.path === 'saveMemoryCandidates'
        ? { inserted: result.inserted, updated: result.updated, superseded: result.superseded }
        : { keys: result.keys }),
    });
  } catch (err) {
    console.error('[extract-memories] failed:', err?.message || err);
    return res.status(502).json({ ok: false, error: String(err?.message || err).slice(0, 300) });
  }
}
