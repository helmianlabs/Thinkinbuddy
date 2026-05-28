// api/memory.js — per-user persistent memory store for ThinkinBuddy.
//
// Uses timestamped blob keys so each write creates a NEW blob URL.
// CDN never has a cached version of the latest data — reads are always fresh.
// list() fetches the most recently uploaded blob for the user.
//
// ISOLATION (2026-05-27): every method now REQUIRES an explicit userId. We no
// longer silently default to 'troy' — a missing userId used to make every
// anonymous/in-call write land in troy's prefix and every read return troy's
// facts (cross-user leak). Callers MUST pass userId (query or body).
//
// IN-CALL save_memory TOOL — REQUIRED DASHBOARD CHANGE:
// The ElevenLabs agent's `save_memory` webhook tool must be edited (Agent →
// Tools → save_memory) to pass the user id. Add a `userId` parameter to the
// tool's body schema (type string, required) and bind it to the dynamic
// variable the client sets per session (see index.html — userId is passed via
// the session override's dynamicVariables / the tool body). Until that schema
// change ships, in-call saves will now 400 instead of silently writing to the
// wrong user — which is the safe failure for an isolation bug.

import { put, list, del } from '@vercel/blob';

const blobPrefix = (userId) => `thinkinbuddy/memory/${userId}/`;

async function readMemory(userId) {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    // Get all blobs for this user, sorted by upload time (newest first)
    const { blobs } = await list({ prefix: blobPrefix(userId), limit: 5, token });
    if (!blobs || blobs.length === 0) return { userId, facts: [] };
    // Most recently uploaded blob is the current memory state
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].url);
    if (!res.ok) return { userId, facts: [] };
    return await res.json();
  } catch {
    return { userId, facts: [] };
  }
}

async function writeMemory(data) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  // Write to a NEW timestamped key — CDN will never have a stale cached version
  await put(
    `${blobPrefix(data.userId)}${Date.now()}.json`,
    JSON.stringify(data),
    { access: 'public', contentType: 'application/json', addRandomSuffix: false, token }
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(500).json({ error: 'Blob not configured' });

  if (req.method === 'GET') {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    return res.status(200).json(await readMemory(userId));
  }

  if (req.method === 'POST') {
    const { key, value } = req.body || {};
    const userId = req.body?.userId || req.query?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!key || !value) return res.status(400).json({ error: 'key and value required' });
    try {
      const memory = await readMemory(userId);
      const idx = memory.facts.findIndex(f => f.key === key);
      const fact = { key, value, savedAt: new Date().toISOString() };
      if (idx >= 0) memory.facts[idx] = fact;
      else memory.facts.push(fact);
      memory.lastUpdated = new Date().toISOString();
      await writeMemory(memory);
      return res.status(200).json({ ok: true, fact });
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'write failed' });
    }
  }

  if (req.method === 'DELETE') {
    const { userId, key } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      const memory = await readMemory(userId);
      memory.facts = memory.facts.filter(f => f.key !== key);
      memory.lastUpdated = new Date().toISOString();
      await writeMemory(memory);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'delete failed' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
