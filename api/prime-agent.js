// api/prime-agent.js — called when the page loads.
//
// Reads the user's persisted memories from Vercel Blob (same path memory.js
// writes to) and RETURNS the per-user system prompt to the CLIENT as JSON.
// The client applies it as a per-SESSION override on the ElevenLabs ConvAI
// widget (event.detail.config.overrides.agent.prompt.prompt) so each user's
// facts stay scoped to THEIR call only.
//
// The personality string comes from lib/personality.js — single source of
// truth. Do NOT inline a prompt here.
//
// ISOLATION FIX (2026-05-27): previously this endpoint PATCHed ONE GLOBAL
// agent's prompt on every page load, so the last user to load the page
// overwrote the shared prompt and every other live caller saw their facts
// (cross-user leak). We no longer mutate the shared agent at all — the prompt
// is returned to the client and applied per-session via the widget's
// `elevenlabs-convai:call` event (the SDK ships it as
// conversation_config_override on that session's socket only). This mirrors
// what script.js does with Conversation.startSession({ overrides }).
//
// NOTE: per-session prompt override requires "Overrides → System prompt" to be
// ENABLED in the ElevenLabs dashboard for this agent (Agent → Security tab).
// If that toggle is off, ElevenLabs ignores the override and falls back to the
// agent's saved prompt. This is a required one-time manual dashboard step.

import { list } from '@vercel/blob';
import { buildSystemPrompt } from '../lib/personality.js';

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
  const userId = req.body?.userId;

  // Isolation: a missing userId can no longer silently collapse onto 'troy'
  // and read someone else's blob prefix. The client always sends the real
  // per-user localStorage id (index.html initApp -> user.userId).
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ ok: false, error: 'userId required' });
  }

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

  // Return the per-user prompt to the client. The client sets it on the
  // widget's per-session override (overrides.agent.prompt.prompt) so user A's
  // facts never touch the shared agent and never reach user B's session.
  // We do NOT PATCH the global agent anymore.
  return res.status(200).json({ ok: true, prompt, memoryCount: facts.length, buddyName, userId });
}
