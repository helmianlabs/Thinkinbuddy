// api/extract-memories.js — called by index.html when an ElevenLabs call ends.
//
// 1. Pulls the conversation transcript from the ElevenLabs ConvAI API.
// 2. Asks Claude to extract durable facts about the user (name, family, goals,
//    projects, preferences, struggles, wins) as { key, value } pairs.
// 3. Merges into the user's existing memory blob (no dupes by key).
// 4. Writes a fresh timestamped blob to thinkinbuddy/memory/{userId}/.
//
// Frontend fires this fire-and-forget on `elevenlabs-convai:call-ended`.
// Response status is for debugging — the client ignores it.

import { put, list } from '@vercel/blob';

const blobPrefix = (userId) => `thinkinbuddy/memory/${userId}/`;

async function readMemory(userId) {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const { blobs } = await list({ prefix: blobPrefix(userId), limit: 5, token });
    if (!blobs?.length) return { userId, facts: [] };
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].url);
    if (!res.ok) return { userId, facts: [] };
    return await res.json();
  } catch (err) {
    console.error('[extract-memories] memory read failed:', err?.message || err);
    return { userId, facts: [] };
  }
}

async function writeMemory(data) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  await put(
    `${blobPrefix(data.userId)}${Date.now()}.json`,
    JSON.stringify(data),
    { access: 'public', contentType: 'application/json', addRandomSuffix: false, token }
  );
}

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

async function extractFacts(transcript, anthropicKey) {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];

  // Flatten transcript into a readable conversation block for Claude.
  const convo = transcript
    .map(t => {
      const role = t.role === 'user' ? 'USER' : 'BUDDY';
      const text = (t.message || '').trim();
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');

  if (!convo) return [];

  const system = `You read a conversation between a user and their AI thinking partner. You return durable facts about the USER worth remembering for next time — name, family, projects, goals, preferences, ongoing struggles, recent wins. Skip transient chit-chat and anything the buddy said about itself.

Return ONLY valid JSON in this exact shape:
{"facts":[{"key":"short_snake_case_id","value":"one short sentence about the user"}]}

If nothing durable came up, return {"facts":[]}.
Limit to 8 facts max. Keep each value under 120 characters.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: convo }],
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Anthropic ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = data?.content?.[0]?.text || '';

  // Find the first JSON object in the response (Claude sometimes wraps it).
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(parsed?.facts)) return [];

  return parsed.facts
    .filter(f => f && typeof f.key === 'string' && typeof f.value === 'string')
    .map(f => ({
      key: f.key.trim().slice(0, 64),
      value: f.value.trim().slice(0, 240),
      savedAt: new Date().toISOString(),
    }))
    .slice(0, 8);
}

function mergeFacts(existing, fresh) {
  const out = [...existing];
  for (const f of fresh) {
    const i = out.findIndex(x => x.key === f.key);
    if (i >= 0) out[i] = f;
    else out.push(f);
  }
  return out;
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
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!elevenKey)    return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (!blobToken)    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not set' });

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
      return res.status(200).json({ ok: true, extracted: 0, reason: 'empty transcript' });
    }

    const fresh = await extractFacts(transcript, anthropicKey);
    if (fresh.length === 0) {
      return res.status(200).json({ ok: true, extracted: 0, reason: 'no durable facts' });
    }

    const memory = await readMemory(userId);
    memory.facts = mergeFacts(memory.facts || [], fresh);
    memory.lastUpdated = new Date().toISOString();
    await writeMemory(memory);

    return res.status(200).json({
      ok: true,
      extracted: fresh.length,
      total: memory.facts.length,
      keys: fresh.map(f => f.key),
    });
  } catch (err) {
    console.error('[extract-memories] failed:', err?.message || err);
    return res.status(502).json({ ok: false, error: String(err?.message || err).slice(0, 300) });
  }
}
