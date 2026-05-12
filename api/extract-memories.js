// api/extract-memories.js — after a call ends, fetch the ElevenLabs transcript,
// use Claude to extract key personal facts, save them to Vercel Blob.
//
// POST body: { userId: string, conversationId: string }

import { put, list } from '@vercel/blob';

const blobKey = (userId) => `thinkinbuddy/memory/${userId}.json`;

async function readMemory(userId) {
  try {
    const { blobs } = await list({ prefix: blobKey(userId), limit: 1, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!blobs || blobs.length === 0) return { userId, facts: [] };
    const res = await fetch(blobs[0].url);
    if (!res.ok) return { userId, facts: [] };
    return await res.json();
  } catch { return { userId, facts: [] }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { userId, conversationId } = req.body || {};
  if (!userId || !conversationId) return res.status(400).json({ error: 'userId and conversationId required' });

  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!elevenKey || !anthropicKey) return res.status(500).json({ error: 'Missing API keys' });

  try {
    // 1. Fetch the transcript from ElevenLabs
    const convRes = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
      { headers: { 'xi-api-key': elevenKey } }
    );
    if (!convRes.ok) return res.status(200).json({ saved: [], reason: 'could not fetch transcript' });

    const conv = await convRes.json();
    const transcript = (conv.transcript || [])
      .map(t => `${t.role}: ${t.message}`)
      .join('\n');

    if (!transcript || transcript.length < 50) return res.status(200).json({ saved: [], reason: 'transcript too short' });

    // 2. Ask Claude to extract memorable personal facts
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        system: `Extract personal facts worth remembering about the user from this conversation transcript.
Return ONLY a JSON array of objects like: [{"key": "short_key", "value": "full fact sentence"}]
Focus on: name, location, family, health, projects, goals, struggles, interests, job.
Ignore small talk. Max 5 facts. If nothing worth remembering, return [].`,
        messages: [{ role: 'user', content: transcript }],
      }),
    });

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || '[]';

    let facts = [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      facts = match ? JSON.parse(match[0]) : [];
    } catch { facts = []; }

    if (facts.length === 0) return res.status(200).json({ saved: [] });

    // 3. Upsert into Vercel Blob memory
    const memory = await readMemory(userId);
    for (const { key, value } of facts) {
      if (!key || !value) continue;
      const idx = memory.facts.findIndex(f => f.key === key);
      const fact = { key, value, savedAt: new Date().toISOString() };
      if (idx >= 0) memory.facts[idx] = fact;
      else memory.facts.push(fact);
    }
    memory.lastUpdated = new Date().toISOString();

    await put(blobKey(userId), JSON.stringify(memory), {
      access: 'public', contentType: 'application/json', addRandomSuffix: false,
    });

    console.log(`[memory] extracted ${facts.length} facts for ${userId}`);
    return res.status(200).json({ saved: facts });
  } catch (err) {
    console.error('[extract-memories]', err);
    return res.status(200).json({ saved: [], error: String(err) });
  }
}
