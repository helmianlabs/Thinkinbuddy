// api/conversation-webhook.js — ElevenLabs POST-CALL webhook receiver.
//
// This is the DURABILITY BACKSTOP for conversation logging: it doesn't
// depend on the browser tab staying alive, the widget firing the right
// event, or anything client-side at all. ElevenLabs stores the full call
// server-side and pushes it here automatically once call analysis
// completes -- so even if the live per-turn capture (conversation-turn.js)
// missed something (tab killed, network blip), the full authoritative
// transcript still lands here and reconciles the record.
//
// ONE-TIME MANUAL SETUP REQUIRED (ElevenLabs workspace webhooks are
// dashboard-configured, not API-configurable -- confirmed via their docs):
//   1. ElevenLabs dashboard -> Settings -> Webhooks -> Create webhook
//   2. Type: "Post-call transcription" (post_call_transcription)
//   3. URL: https://<this-deployment>/api/conversation-webhook
//   4. Copy the shared secret it generates into Vercel env var
//      ELEVENLABS_POSTCALL_WEBHOOK_SECRET (all environments), then redeploy.
//   5. In the agent's settings, enable this workspace webhook for THIS agent.
//
// HMAC verification follows ElevenLabs' documented convention: header
// `ElevenLabs-Signature: t=<unix_ts>,v0=<hex hmac-sha256 of "t.rawBody">`.
// This has not yet been verified against a live sample (the webhook doesn't
// exist until step 1-4 above happen) -- if ElevenLabs' actual header shape
// differs, the fix is isolated to verifySignature() below.
//
// Until ELEVENLABS_POSTCALL_WEBHOOK_SECRET is set, this endpoint REJECTS
// every request (fail-closed) rather than accepting unverified writes.

import crypto from 'node:crypto';
import { getPool } from '../server/handlers/memory.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=').map((s) => s.trim()))
  );
  const t = parts.t;
  const v0 = parts.v0;
  if (!t || !v0) return false;
  // Reject stale signatures (>30 min) to limit replay window.
  const ageSec = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(ageSec) || ageSec > 1800) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody.toString('utf8')}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v0));
  } catch {
    return false;
  }
}

function extractTurns(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .map((t, i) => ({
      turnIndex: i,
      role: t.role === 'user' ? 'user' : 'agent',
      content: typeof t.message === 'string' ? t.message : (typeof t.text === 'string' ? t.text : null),
      raw: t,
    }))
    .filter((t) => t.content !== null);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.ELEVENLABS_POSTCALL_WEBHOOK_SECRET;
  const rawBody = await readRawBody(req);

  if (!secret) {
    console.error('[conversation-webhook] ELEVENLABS_POSTCALL_WEBHOOK_SECRET not set -- rejecting (fail-closed)');
    return res.status(503).json({ error: 'webhook not configured' });
  }

  const sig = req.headers['elevenlabs-signature'];
  if (!verifySignature(rawBody, sig, secret)) {
    console.error('[conversation-webhook] signature verification failed');
    return res.status(401).json({ error: 'invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid JSON' });
  }

  // ElevenLabs must get a prompt 200 to consider the webhook delivered --
  // acknowledge immediately, do the (idempotent, safely retriable) DB work
  // after. If something below throws, ElevenLabs' own retry policy on a
  // non-200 would otherwise hammer us; since we've already durably logged
  // the raw payload is not guaranteed here, we do the work inline but keep
  // it small and fast (single conversation, indexed writes).
  try {
    const data = payload?.data || payload;
    const conversationId = data?.conversation_id || data?.conversationId;
    const agentId = data?.agent_id || data?.agentId;
    const transcript = data?.transcript || [];
    const turns = extractTurns(transcript);

    if (!conversationId) {
      console.error('[conversation-webhook] no conversation_id in payload -- cannot reconcile');
      return res.status(200).json({ ok: true, reconciled: false, reason: 'no conversation_id' });
    }

    const pool = getPool();

    // Find (or create) the session for this conversation_id. If a live
    // session already exists (conversation-turn.js set it), reconcile into
    // it. Otherwise this webhook is the FIRST time we've heard about this
    // call at all (client-side capture failed entirely) -- create a new
    // session keyed by conversation_id itself.
    const existing = await pool.query(
      `SELECT id FROM conversation_sessions WHERE conversation_id = $1`,
      [conversationId]
    );
    let sessionId = existing.rows[0]?.id;
    if (!sessionId) {
      sessionId = conversationId; // deterministic fallback id, still a valid UUID-shaped text key check below
      const isUuidLike = /^[0-9a-f-]{20,}$/i.test(conversationId);
      const insertId = isUuidLike ? conversationId : crypto.randomUUID();
      await pool.query(
        `INSERT INTO conversation_sessions (id, user_id, conversation_id, agent_id, source)
         VALUES ($1, $2, $3, $4, 'post_call_webhook_only')
         ON CONFLICT (id) DO NOTHING`,
        [insertId, 'troy', conversationId, agentId || null]
      );
      sessionId = insertId;
    }

    for (const t of turns) {
      await pool.query(
        `INSERT INTO conversation_turns (session_id, turn_index, role, content, raw, source)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'post_call_webhook')
         ON CONFLICT (session_id, turn_index) DO UPDATE
           SET content = EXCLUDED.content, raw = EXCLUDED.raw, source = 'post_call_webhook'`,
        [sessionId, t.turnIndex, t.role, t.content?.slice(0, 10000) || null, JSON.stringify(t.raw).slice(0, 20000)]
      );
    }

    await pool.query(
      `UPDATE conversation_sessions
          SET ended_at = now(), reconciled = true, end_reason = 'post_call_webhook',
              turn_count = (SELECT count(*) FROM conversation_turns WHERE session_id = $1)
        WHERE id = $1`,
      [sessionId]
    );

    console.log('[conversation-webhook] reconciled', conversationId, 'turns:', turns.length);
    return res.status(200).json({ ok: true, reconciled: true, turns: turns.length });
  } catch (err) {
    console.error('[conversation-webhook] failed:', err?.message || err);
    // Still 200 -- we don't want ElevenLabs retry-storming an endpoint that
    // is failing for a persistent reason (e.g. a schema issue); errors are
    // visible in Vercel logs instead.
    return res.status(200).json({ ok: false, error: err?.message || 'reconcile failed' });
  }
}
