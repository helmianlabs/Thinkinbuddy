// api/save-memory.js — called after each conversation turn to parse and save
// [REMEMBER: key | value] tags from the agent's transcript.
//
// POST body: { userId: string, transcript: string }
// Returns:   { saved: [{key, value}] }

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

async function writeMemory(data) {
  await put(blobKey(data.userId), JSON.stringify(data), {
    access: 'public', contentType: 'application/json', addRandomSuffix: false,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { userId, transcript } = req.body || {};
  if (!userId || !transcript) return res.status(400).json({ error: 'userId and transcript required' });

  // Parse [REMEMBER: key | value] tags
  const pattern = /\[REMEMBER:\s*([^|]+)\|\s*([^\]]+)\]/gi;
  const saved = [];
  let match;
  while ((match = pattern.exec(transcript)) !== null) {
    saved.push({ key: match[1].trim(), value: match[2].trim() });
  }

  if (saved.length === 0) return res.status(200).json({ saved: [] });

  const memory = await readMemory(userId);
  for (const { key, value } of saved) {
    const idx = memory.facts.findIndex(f => f.key === key);
    const fact = { key, value, savedAt: new Date().toISOString() };
    if (idx >= 0) memory.facts[idx] = fact;
    else memory.facts.push(fact);
  }
  memory.lastUpdated = new Date().toISOString();
  await writeMemory(memory);

  console.log(`[memory] saved ${saved.length} facts for ${userId}:`, saved);
  return res.status(200).json({ saved });
}
