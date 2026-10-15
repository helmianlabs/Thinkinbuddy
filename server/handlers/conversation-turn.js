// api/conversation-turn.js — LIVE, continuous per-turn transcript capture.
//
// Called from index.html's onMessage hook for every turn, AS THE CALL
// HAPPENS — this is the primary fix for "the conversation didn't save":
// instead of waiting for the call to end and then trying to reconstruct the
// transcript (fragile — depends on capturing ElevenLabs' conversationId and
// the browser staying alive), each turn is durably written to Neon the
// moment it occurs.
//
// sessionId is a client-generated UUID (crypto.randomUUID()) created the
// INSTANT a call starts — never blocked on ElevenLabs' own conversation_id,
// which the widget doesn't always surface promptly (see index.html comments
// around lastConversationId). conversationId is attached opportunistically
// once known and is what api/conversation-webhook.js uses to reconcile the
// authoritative post-call transcript against this live-captured one.
//
// Idempotent: (session_id, turn_index) is unique, so retries/duplicate
// onMessage fires never create duplicate rows.

import { getPool } from './memory.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionId, userId, conversationId, agentId, turnIndex, role, content, raw } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (typeof turnIndex !== 'number') return res.status(400).json({ error: 'turnIndex (number) required' });
  if (!role) return res.status(400).json({ error: 'role required' });

  try {
    const pool = getPool();

    await pool.query(
      `INSERT INTO conversation_sessions (id, user_id, conversation_id, agent_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET conversation_id = COALESCE(conversation_sessions.conversation_id, EXCLUDED.conversation_id)`,
      [sessionId, userId, conversationId || null, agentId || null]
    );

    await pool.query(
      `INSERT INTO conversation_turns (session_id, turn_index, role, content, raw, source)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'live')
       ON CONFLICT (session_id, turn_index) DO UPDATE
         SET content = EXCLUDED.content, raw = EXCLUDED.raw`,
      [sessionId, turnIndex, String(role).slice(0, 20), content ? String(content).slice(0, 10000) : null,
        raw ? JSON.stringify(raw).slice(0, 20000) : null]
    );

    await pool.query(
      `UPDATE conversation_sessions
          SET turn_count = (SELECT count(*) FROM conversation_turns WHERE session_id = $1)
        WHERE id = $1`,
      [sessionId]
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[conversation-turn] failed:', err?.message || err);
    // Never breaks the call itself -- the client fires this best-effort.
    return res.status(500).json({ ok: false, error: err?.message || 'save failed' });
  }
}
