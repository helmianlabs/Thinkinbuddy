// Research data logging endpoint.
//
// PRIVACY (audit §2 gap 11 — fixed in the final sweep): the previous
// version wrote the RAW conversation text into a PUBLIC Vercel Blob.
// This version never stores message content at all. What is stored is
// redacted session metadata only — counts, roles, and per-message
// lengths — which is enough for aggregate research questions (session
// length, turn balance) and contains nothing a reader could quote,
// search, or attribute. No message text, no names, no free-form
// userContext strings are persisted; the participant is represented
// only by a SHA-256 hash of their id, and the stored object is JSON,
// not a transcript.
//
// Only fires when the user has explicitly consented (consentResearch
// flag in payload).

import { createHash } from 'node:crypto';

function hashString(str) {
  return createHash('sha256').update(String(str)).digest('hex');
}

function normalizeRole(role) {
  if (role === 'user') return 'user';
  if (role === 'assistant' || role === 'agent' || role === 'buddy') return 'assistant';
  return 'other';
}

function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, part) => n + (typeof part === 'string'
      ? part.length
      : (typeof part?.text === 'string' ? part.text.length : 0)), 0);
  }
  return 0;
}

/**
 * Build the ONLY object this endpoint is allowed to persist.
 * Exported for the redaction test: it must be impossible for any
 * caller-supplied string (message content, researchTag, ageRange,
 * names) to appear in the returned object.
 *
 * @param {Array<{role?: string, content?: unknown}>} conversation
 * @param {object} [userContext]
 * @returns {object} redacted metadata (counts + lengths + hashes only)
 */
export function buildResearchLogMetadata(conversation, userContext = {}) {
  const messages = (Array.isArray(conversation) ? conversation : []).map((msg) => ({
    role: normalizeRole(msg?.role),
    content_length: contentLength(msg?.content),
  }));
  return {
    kind: 'thinkinbuddy-research-session-metadata',
    version: 2,
    session_date: new Date().toISOString(),
    consent_recorded: Boolean(userContext?.consentDate),
    participant_hash: userContext?.userId ? hashString(userContext.userId) : 'anon',
    message_count: messages.length,
    user_message_count: messages.filter((m) => m.role === 'user').length,
    assistant_message_count: messages.filter((m) => m.role === 'assistant').length,
    total_content_characters: messages.reduce((n, m) => n + m.content_length, 0),
    messages,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { conversation, userContext, consentResearch } = req.body || {};

  // Hard gate: do NOT log without explicit consent flag
  if (!consentResearch) {
    return res.status(200).json({ logged: false, reason: 'no consent' });
  }

  if (!conversation || !Array.isArray(conversation) || conversation.length === 0) {
    return res.status(400).json({ error: 'conversation array required' });
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    return res.status(500).json({ error: 'Blob storage not configured' });
  }

  try {
    const { put } = await import('@vercel/blob');

    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = `research/${new Date().toISOString().slice(0, 10)}/${sessionId}.json`;
    const metadata = buildResearchLogMetadata(conversation, userContext);

    await put(filename, JSON.stringify(metadata, null, 2), {
      access: 'public',
      contentType: 'application/json',
      token: blobToken,
    });

    return res.status(200).json({ logged: true, sessionId });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to log', details: e.message });
  }
}
