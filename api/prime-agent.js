// api/prime-agent.js — called when the page loads.
//
// Reads the user's persisted memories from Vercel Blob (same path memory.js
// writes to) and PATCHes the ElevenLabs ConvAI agent's system prompt so the
// agent boots already knowing the user's facts.
//
// The personality string comes from lib/personality.js — single source of
// truth. Do NOT inline a prompt here.
//
// NOTE: the ElevenLabs agent prompt is GLOBAL (one prompt across all users
// who hit this agent). Fine for single-user / single-tenant use. For real
// multi-user, switch the client to per-session overrides via
// Conversation.startSession({ overrides }) like script.js does.

import { list } from '@vercel/blob';
import { buildSystemPrompt } from '../lib/personality.js';

const AGENT_ID = 'agent_4401kqcb0w2dey28c69zhchv7ayn';

const blobPrefix = (userId) => `thinkinbuddy/memory/${userId}/`;

async function getMemories(userId) {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const { blobs } = await list({ prefix: blobPrefix(userId), limit: 5, token });
    if (!blobs?.length) return [];
    // Most recently uploaded blob is the current memory state.
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.facts || [];
  } catch (err) {
    console.error('[prime-agent] memory read failed:', err?.message || err);
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const buddyName = req.body?.buddyName || 'ThinkinBuddy';
  const userName = req.body?.userName || null;
  const userId = req.body?.userId || 'troy';

  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });

  const facts = await getMemories(userId);

  // ElevenLabs widget path: it has REAL tool calls registered on the agent,
  // so we don't need the action-tag fallback here. Tools block stays.
  const prompt = buildSystemPrompt({
    buddyName,
    userName,
    memories: facts,
    includeToolsBlock: true,
    includeActionTags: false,
  });

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}`, {
      method: 'PATCH',
      headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_config: { agent: { prompt: { prompt } } } }),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error('[prime-agent] PATCH failed:', r.status, err.slice(0, 200));
      return res.status(502).json({ ok: false, status: r.status, error: err.slice(0, 200) });
    }
    return res.status(200).json({ ok: true, memoryCount: facts.length, buddyName, userId });
  } catch (err) {
    console.error('[prime-agent] PATCH error:', err?.message || err);
    return res.status(502).json({ ok: false, error: String(err?.message || err) });
  }
}
