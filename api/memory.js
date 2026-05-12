// api/memory.js — per-user persistent memory store for ThinkinBuddy.
//
// GET  /api/memory?userId=<id>        → returns { facts: [...] }
// POST /api/memory                    → body { userId, key, value } → saves fact
// DELETE /api/memory?userId=&key=     → removes a specific fact
//
// Facts are stored as a single JSON blob per user in Vercel Blob:
//   thinkinbuddy/memory/<userId>.json
//
// Injected into the system prompt at session start so ThinkinBuddy
// remembers details across conversations like a real friend would.

import { put, list } from '@vercel/blob';

const blobKey = (userId) => `thinkinbuddy/memory/${userId}.json`;

async function readMemory(userId) {
  try {
    // Use list() to find the actual blob URL (includes the store-specific prefix)
    const { blobs } = await list({ prefix: blobKey(userId), limit: 1, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!blobs || blobs.length === 0) return { userId, facts: [] };
    const res = await fetch(blobs[0].url);
    if (!res.ok) return { userId, facts: [] };
    return await res.json();
  } catch {
    return { userId, facts: [] };
  }
}

async function writeMemory(data) {
  await put(blobKey(data.userId), JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(500).json({ error: 'Blob not configured' });

  // ── GET — fetch all facts for a user ────────────────────────────────────
  if (req.method === 'GET') {
    const userId = req.query.userId || 'troy';
    const memory = await readMemory(userId);
    return res.status(200).json(memory);
  }

  // ── POST — save a fact ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { key, value } = req.body || {};
    // userId is optional — default to 'troy' so the agent doesn't need to track it
    const userId = req.body?.userId || req.query?.userId || 'troy';
    if (!key || !value) {
      return res.status(400).json({ error: 'key and value required' });
    }

    const memory = await readMemory(userId);

    // Upsert by key
    const idx = memory.facts.findIndex(f => f.key === key);
    const fact = { key, value, savedAt: new Date().toISOString() };
    if (idx >= 0) {
      memory.facts[idx] = fact;
    } else {
      memory.facts.push(fact);
    }
    memory.lastUpdated = new Date().toISOString();

    await writeMemory(memory);
    return res.status(200).json({ ok: true, fact });
  }

  // ── DELETE — remove a specific fact ─────────────────────────────────────
  if (req.method === 'DELETE') {
    const { userId, key } = req.query;
    if (!userId || !key) return res.status(400).json({ error: 'userId and key required' });

    const memory = await readMemory(userId);
    memory.facts = memory.facts.filter(f => f.key !== key);
    memory.lastUpdated = new Date().toISOString();

    await writeMemory(memory);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
